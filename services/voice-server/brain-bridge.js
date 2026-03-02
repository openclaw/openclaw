/**
 * Brain Bridge — HTTP + WebSocket relay between Voice Server and Brain Worker.
 *
 * Architecture:
 *   Voice Server (port 8765, server.js)
 *     → connects as WS client to ws://localhost:8766/ws
 *     → sends { type: 'think', requestId, text }
 *     → receives { type: 'response', requestId, text }
 *
 *   Brain Worker (brain-worker.js)
 *     → GET  /poll?timeout=25000  (long-polls for think requests)
 *     → POST /respond  { requestId, text }  (sends back responses)
 *
 *   Health:
 *     → GET /health  (returns status JSON)
 *
 * Usage: node brain-bridge.js
 */

import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";

const PORT = parseInt(process.env.BRIDGE_PORT || "8766");

// ─── Pending Requests Queue ─────────────────────────────────────

/** @type {Map<string, { text: string, resolve: (text: string) => void, timer: NodeJS.Timeout }>} */
const pendingRequests = new Map();

/** @type {Array<{ requestId: string, text: string, resolve: (resp: import('http').ServerResponse) => void }>} */
const pollWaiters = [];

/** @type {Set<WebSocket>} */
const voiceClients = new Set();

// ─── HTTP Server ────────────────────────────────────────────────

const httpServer = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        voiceClients: voiceClients.size,
        pendingRequests: pendingRequests.size,
        pollWaiters: pollWaiters.length,
        uptime: process.uptime(),
      }),
    );
    return;
  }

  // Brain Worker polls for think requests
  if (url.pathname === "/poll" && req.method === "GET") {
    const timeout = parseInt(url.searchParams.get("timeout") || "25000");

    // Check if there's already a pending request
    if (pendingRequests.size > 0) {
      const [requestId, entry] = pendingRequests.entries().next().value;
      // Don't remove yet — wait for /respond
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ requestId, text: entry.text }));
      return;
    }

    // Long-poll: wait for a think request
    const timer = setTimeout(() => {
      const idx = pollWaiters.findIndex((w) => w.res === res);
      if (idx >= 0) {
        pollWaiters.splice(idx, 1);
      }
      res.writeHead(204);
      res.end();
    }, timeout);

    pollWaiters.push({ res, timer });

    // Handle client disconnect
    req.on("close", () => {
      clearTimeout(timer);
      const idx = pollWaiters.findIndex((w) => w.res === res);
      if (idx >= 0) {
        pollWaiters.splice(idx, 1);
      }
    });

    return;
  }

  // Brain Worker responds to a think request
  if (url.pathname === "/respond" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const { requestId, text } = JSON.parse(body);
        const entry = pendingRequests.get(requestId);
        if (entry) {
          clearTimeout(entry.timer);
          pendingRequests.delete(requestId);
          // Send response back to voice server via WebSocket
          for (const ws of voiceClients) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "response", requestId, text }));
            }
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Request not found or expired" }));
        }
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 404 for unknown routes
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

// ─── WebSocket Server (for voice server) ────────────────────────

const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

wss.on("connection", (ws) => {
  console.log("🔗 Voice server connected");
  voiceClients.add(ws);

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(/** @type {Buffer} */ (raw).toString());

      if (msg.type === "think" && msg.requestId && msg.text) {
        console.log(
          `📥 Think request [${msg.requestId}]: "${msg.text.slice(0, 60)}${msg.text.length > 60 ? "..." : ""}"`,
        );

        // Timeout after 30s if brain doesn't respond
        const timer = setTimeout(() => {
          if (pendingRequests.has(msg.requestId)) {
            pendingRequests.delete(msg.requestId);
            // Send timeout response back to voice server
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "response",
                  requestId: msg.requestId,
                  text: "I'm thinking... give me just a moment.",
                }),
              );
            }
          }
        }, 30000);

        pendingRequests.set(msg.requestId, { text: msg.text, timer });

        // Wake up any waiting pollers
        if (pollWaiters.length > 0) {
          const waiter = pollWaiters.shift();
          clearTimeout(waiter.timer);
          waiter.res.writeHead(200, { "Content-Type": "application/json" });
          waiter.res.end(JSON.stringify({ requestId: msg.requestId, text: msg.text }));
        }
      }
    } catch (err) {
      console.error("❌ WS parse error:", err.message);
    }
  });

  ws.on("close", () => {
    console.log("🔌 Voice server disconnected");
    voiceClients.delete(ws);
  });

  ws.on("error", (err) => {
    console.error("❌ WS error:", err.message);
    voiceClients.delete(ws);
  });
});

// ─── Start ──────────────────────────────────────────────────────

httpServer.listen(PORT, "127.0.0.1", () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║  🌉 Brain Bridge v1.0                           ║
╠══════════════════════════════════════════════════╣
║  HTTP:    http://localhost:${PORT}                ║
║  WS:      ws://localhost:${PORT}/ws               ║
║  Health:  http://localhost:${PORT}/health          ║
╚══════════════════════════════════════════════════╝
  `);
});
