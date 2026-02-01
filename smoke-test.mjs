#!/usr/bin/env node
// Smoke test: connect as a node to the gateway and log all events
import { WebSocket } from 'ws';
import crypto from 'crypto';

const WS_URL = 'ws://127.0.0.1:18789';
const TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '';

const ws = new WebSocket(WS_URL);
let reqId = 0;
const pending = new Map();

function send(obj) {
  const data = JSON.stringify(obj);
  console.log('>>> SEND:', data.slice(0, 200));
  ws.send(data);
}

function request(method, params) {
  const id = `smoke-${++reqId}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ type: 'req', id, method, params });
    setTimeout(() => { pending.delete(id); reject(new Error('timeout')); }, 15000);
  });
}

ws.on('open', () => {
  console.log('--- Connected to', WS_URL);
});

ws.on('message', async (raw) => {
  const msg = JSON.parse(raw.toString());
  
  // Handle responses
  if (msg.type === 'res') {
    console.log('<<< RES:', JSON.stringify(msg).slice(0, 500));
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); p.resolve(msg); }
    return;
  }

  // Handle events
  if (msg.type === 'event') {
    console.log('<<< EVENT:', msg.event, JSON.stringify(msg.payload || {}).slice(0, 300));
    
    // Respond to challenge
    if (msg.event === 'connect.challenge') {
      console.log('--- Got challenge, sending handshake...');
      try {
        const resp = await request('connect', {
          minProtocol: 3,
          maxProtocol: 3,
          client: {
            id: 'smoke-test',
            version: '0.0.1',
            platform: 'linux',
            mode: 'node',
          },
          role: 'node',
          scopes: [],
          caps: ['camera', 'canvas', 'screen', 'location', 'voice'],
          commands: [],
          permissions: {},
          auth: { token: TOKEN },
          locale: 'en-US',
          userAgent: 'smoke-test/0.0.1',
          device: {
            id: 'smoke-' + crypto.randomUUID(),
          },
        });
        
        console.log('\n=== HELLO-OK PAYLOAD ===');
        const payload = resp.payload || resp;
        console.log(JSON.stringify(payload, null, 2).slice(0, 2000));
        
        // Check for identity field
        if (payload.identity) {
          console.log('\n✅ IDENTITY FOUND:', JSON.stringify(payload.identity));
        } else {
          console.log('\n❌ No identity field in hello-ok (expected — PR #6430 not merged yet)');
        }

        // Subscribe to chat events
        send({ type: 'req', id: `smoke-${++reqId}`, method: 'node.event', params: { event: 'chat.subscribe', payloadJSON: '{}' } });
        
        // Subscribe to ambient/canvas
        send({ type: 'req', id: `smoke-${++reqId}`, method: 'node.event', params: { event: 'ambient.subscribe', payloadJSON: '{}' } });

        console.log('\n--- Listening for events (30s)...\n');
        setTimeout(() => {
          console.log('\n--- Smoke test complete, closing.');
          ws.close();
          process.exit(0);
        }, 30000);
        
      } catch (e) {
        console.error('Handshake failed:', e.message);
        ws.close();
        process.exit(1);
      }
    }
    return;
  }
  
  console.log('<<< OTHER:', JSON.stringify(msg).slice(0, 300));
});

ws.on('error', (err) => {
  console.error('WS Error:', err.message);
  process.exit(1);
});

ws.on('close', (code, reason) => {
  console.log('--- Disconnected:', code, reason.toString());
});
