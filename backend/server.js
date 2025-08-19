// QDESK Minimal API (Express + ws)
// Single-file demo backend with in-memory storage.
// -------------------------------------------------
// Quick start:
// 1) Create a folder, save this file as server.js
// 2) Create package.json with:
// {
//   "name": "qdesk-api",
//   "type": "module",
//   "version": "0.1.0",
//   "main": "server.js",
//   "scripts": { "start": "node server.js" },
//   "dependencies": { "express": "^4", "cors": "^2", "ws": "^8", "nanoid": "^5" }
// }
// 3) npm i
// 4) npm start (defaults to PORT=4000)
// 5) Set API_BASE in cabinet.html to http://localhost:4000

import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { nanoid } from 'nanoid';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;

// ------------------ In-memory DB ------------------
const db = {
  users: new Map(), // id -> {id, email, name}
  emailCodes: new Map(), // email -> code
  tokens: new Map(), // token -> userId
  listings: new Map(), // id -> {id, userId, title, price, desc, city, cat, views, ts}
  favorites: new Map(), // userId -> Set(listingId)
  threads: new Map(), // threadId -> {id, members:[userIds], lastTs}
  messages: new Map(), // threadId -> [{from, text, ts}]
  spots: new Map(), // id -> {id, userId, city, datetime, status, qr}
};

// Seed demo user (optional)
function ensureUserByEmail(email){
  for (const u of db.users.values()) if (u.email === email) return u;
  const user = { id: 'u_'+nanoid(8), email, name: email.split('@')[0] };
  db.users.set(user.id, user);
  return user;
}

// ------------------ Helpers ------------------
function authMiddleware(req, res, next){
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ')? h.slice(7) : null;
  if(!token || !db.tokens.has(token)) return res.status(401).json({error:'unauthorized'});
  const userId = db.tokens.get(token);
  req.user = db.users.get(userId);
  if(!req.user) return res.status(401).json({error:'invalid user'});
  next();
}

function pick(o, keys){ const r={}; for(const k of keys) if(k in o) r[k]=o[k]; return r; }

// ------------------ Auth ------------------
app.post('/auth/email/start', (req,res)=>{
  const { email } = req.body || {};
  if(!email) return res.status(400).json({error:'email required'});
  const code = (''+Math.floor(100000+Math.random()*900000));
  db.emailCodes.set(email, code);
  // In real life, send email. For demo, print to console:
  console.log(`[AUTH] Code for ${email}: ${code}`);
  res.json({ ok:true });
});

app.post('/auth/email/verify', (req,res)=>{
  const { email, code, name } = req.body || {};
  if(!email || !code) return res.status(400).json({error:'email & code required'});
  const real = db.emailCodes.get(email);
  if(real !== code) return res.status(400).json({error:'invalid code'});
  db.emailCodes.delete(email);
  const user = ensureUserByEmail(email);
  if(name) user.name = name;
  const token = 't_'+nanoid(24);
  db.tokens.set(token, user.id);
  res.json({ token, user });
});

app.get('/me', authMiddleware, (req,res)=>{ res.json(req.user); });

// ------------------ Listings ------------------
app.get('/listings', authMiddleware, (req,res)=>{
  const items = [...db.listings.values()].sort((a,b)=>b.ts-a.ts);
  res.json({ items });
});

app.post('/listings', authMiddleware, (req,res)=>{
  const { title, price=0, desc='', city='', cat='' } = req.body || {};
  if(!title) return res.status(400).json({error:'title required'});
  const it = { id:'l_'+nanoid(8), userId:req.user.id, title, price:+price||0, desc, city, cat, views:0, ts:Date.now() };
  db.listings.set(it.id, it);
  res.json(it);
});

app.put('/listings/:id', authMiddleware, (req,res)=>{
  const it = db.listings.get(req.params.id);
  if(!it) return res.status(404).json({error:'not found'});
  if(it.userId !== req.user.id) return res.status(403).json({error:'forbidden'});
  Object.assign(it, pick(req.body, ['title','price','desc','city','cat']));
  res.json(it);
});

app.delete('/listings/:id', authMiddleware, (req,res)=>{
  const it = db.listings.get(req.params.id);
  if(!it) return res.status(404).json({error:'not found'});
  if(it.userId !== req.user.id) return res.status(403).json({error:'forbidden'});
  db.listings.delete(req.params.id);
  res.json({ ok:true });
});

// ------------------ Favorites ------------------
function favSet(userId){ if(!db.favorites.has(userId)) db.favorites.set(userId, new Set()); return db.favorites.get(userId); }

app.get('/favorites', authMiddleware, (req,res)=>{
  const ids = [...favSet(req.user.id)];
  res.json({ items: ids.map(id=>({ listingId:id })) });
});

app.post('/favorites/:listingId', authMiddleware, (req,res)=>{
  const { listingId } = req.params;
  if(!db.listings.has(listingId)) return res.status(404).json({error:'listing not found'});
  favSet(req.user.id).add(listingId);
  res.json({ ok:true });
});

app.delete('/favorites/:listingId', authMiddleware, (req,res)=>{
  favSet(req.user.id).delete(req.params.listingId);
  res.json({ ok:true });
});

// ------------------ Threads & Messages ------------------
function ensureThread(threadId){
  if(!db.threads.has(threadId)) db.threads.set(threadId, { id:threadId, members:[], lastTs:0 });
  if(!db.messages.has(threadId)) db.messages.set(threadId, []);
}

app.get('/threads', authMiddleware, (req,res)=>{
  const items = [...db.threads.values()].filter(t=> t.members.length===0 || t.members.includes(req.user.id));
  res.json({ items });
});

app.get('/threads/:id/messages', authMiddleware, (req,res)=>{
  const { id } = req.params; ensureThread(id);
  const msgs = db.messages.get(id);
  res.json({ items: msgs });
});

app.post('/threads/:id/messages', authMiddleware, (req,res)=>{
  const { id } = req.params; const { text } = req.body || {};
  if(!text) return res.status(400).json({error:'text required'});
  ensureThread(id);
  const msg = { from:req.user.id, text, ts:Date.now() };
  const arr = db.messages.get(id); arr.push(msg);
  const t = db.threads.get(id); t.lastTs = msg.ts; if(!t.members.includes(req.user.id)) t.members.push(req.user.id);
  // broadcast WS
  broadcastToThread(id, { type:'message', payload: msg });
  res.json(msg);
});

// ------------------ QDESK Spot ------------------
app.get('/spots', authMiddleware, (req,res)=>{
  const city = (req.query.city||'').toString().toLowerCase();
  const items = [...db.spots.values()].filter(s=> s.userId===req.user.id && (!city || s.city.toLowerCase().includes(city)) ).sort((a,b)=>b.datetime.localeCompare(a.datetime));
  res.json({ items });
});

app.post('/spots/book', authMiddleware, (req,res)=>{
  const { city, datetime } = req.body || {};
  if(!city || !datetime) return res.status(400).json({error:'city & datetime required'});
  const id = 'S'+nanoid(6).toUpperCase();
  const s = { id, userId:req.user.id, city, datetime, status:'Забронировано', qr:'QR-'+id };
  db.spots.set(id, s);
  res.json(s);
});

// ------------------ Server & WebSocket ------------------
const server = app.listen(PORT, ()=>{
  console.log('QDESK API listening on http://localhost:'+PORT);
});

const wss = new WebSocketServer({ server, path: '/chat' });
const clientsByThread = new Map(); // threadId -> Set(ws)

function addClientToThread(threadId, ws){
  if(!clientsByThread.has(threadId)) clientsByThread.set(threadId, new Set());
  clientsByThread.get(threadId).add(ws);
  ws.on('close', ()=> clientsByThread.get(threadId)?.delete(ws));
}

function broadcastToThread(threadId, data){
  const set = clientsByThread.get(threadId); if(!set) return;
  const payload = JSON.stringify(data);
  for(const ws of set){ try{ ws.send(payload); }catch(e){} }
}

wss.on('connection', (ws, req)=>{
  // Expect query: ?threadId=...&token=...
  const url = new URL(req.url, 'http://localhost');
  const threadId = url.searchParams.get('threadId');
  const token = url.searchParams.get('token');
  if(!threadId || !token || !db.tokens.has(token)) { ws.close(1008, 'unauthorized'); return; }
  const userId = db.tokens.get(token);
  ensureThread(threadId);
  const t = db.threads.get(threadId);
  if(!t.members.includes(userId)) t.members.push(userId);
  addClientToThread(threadId, ws);

  ws.send(JSON.stringify({ type:'hello', payload:{ threadId, userId } }));

  ws.on('message', (buf)=>{
    try{
      const { text } = JSON.parse(buf.toString());
      if(!text) return;
      const msg = { from:userId, text, ts:Date.now() };
      db.messages.get(threadId).push(msg);
      t.lastTs = msg.ts;
      broadcastToThread(threadId, { type:'message', payload: msg });
    }catch(e){ /* ignore */ }
  });
});

// ------------------ Health ------------------
app.get('/', (req,res)=>res.json({ ok:true, service:'qdesk-api', now:Date.now() }));
