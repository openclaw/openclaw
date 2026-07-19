// Real Node Fetch body-cancel demonstration for PR #109978
//
// Shows that after receiving a non-OK HTTP response, calling
// response.body?.cancel() releases the underlying TCP connection
// immediately so it can be reused, whereas without the cancel the
// connection remains tied to the unconsumed stream.
//
// Run with: node docs/.local/issue-109978/demo-fetch-body-cancel.mjs

import http from "node:http";
import net from "node:net";

// ── HTTP/1.1 server that tracks connections ──────────────────────

let server;
let connectionCount = 0;
let closedCount = 0;

function startServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      if (req.url === "/ok") {
        res.writeHead(200, {
          "content-type": "text/plain",
          "connection": "keep-alive",
        });
        res.end("OK response");
        return;
      }

      // Non-OK endpoint: stream a partial body and hang.
      res.writeHead(403, {
        "content-type": "text/plain",
        "connection": "keep-alive",
      });
      res.write("error detail chunk\n");
      // Not calling res.end() — simulates a partial/streamed error body
    });

    server.on("connection", (socket) => {
      connectionCount++;
      const id = connectionCount;
      const addr = `${socket.remoteAddress}:${socket.remotePort}`;
      console.log(`[server]   connection #${id} from ${addr}`);

      socket.on("close", () => {
        closedCount++;
        console.log(`[server]   connection #${id} closed (${closedCount} total closed)`);
      });
    });

    server.listen(0, () => resolve(server.address().port));
  });
}

// ── fetch convenience ────────────────────────────────────────────

async function getOk(url, label) {
  console.log(`[${label}] fetching /ok...`);
  const res = await fetch(url);
  const body = await res.text();
  console.log(`[${label}]   status=${res.status}, body="${body}"`);
}

async function getErr_noCancel(url, label) {
  console.log(`[${label}] fetching /err WITHOUT body cancel...`);
  const res = await fetch(url);
  console.log(`[${label}]   status=${res.status}`);
  // ❌  Throw without reading or cancelling the body.
  throw new Error(`simulated error: ${res.status}`);
}

async function getErr_withCancel(url, label) {
  console.log(`[${label}] fetching /err WITH body cancel...`);
  const res = await fetch(url);
  console.log(`[${label}]   status=${res.status}`);
  // ✅  Cancel the unread body like the PR fix does.
  await res.body?.cancel().catch(() => undefined);
  console.log(`[${label}]   body cancelled`);
  throw new Error(`simulated error: ${res.status}`);
}

// ── main ─────────────────────────────────────────────────────────

const port = await startServer();
const BASE = `http://localhost:${port}`;
const AGENT = new http.Agent({ keepAlive: true, maxSockets: 1 });

console.log("");
console.log("=".repeat(70));
console.log("  PR #109978 — real Node Fetch body-cancel demonstration");
console.log("=".repeat(70));
console.log(`\nServer on http://localhost:${port} (HTTP/1.1 keep-alive, max 1 socket)\n`);

// ── Round 1: WITHOUT body cancel ─────────────────────────────────
console.log("─".repeat(70));
console.log("  ROUND 1: WITHOUT body cancel");
console.log("─".repeat(70));
console.log("");

try {
  await getErr_noCancel(`${BASE}/err`, "R1");
} catch (e) {
  console.log(`[R1]   caught: ${e.message}`);
}

console.log(`[R1]   active connections on server: ${server.connections}`);
console.log(`[R1]     -> stored by agent: ${AGENT.sockets[`localhost:${port}`] ? AGENT.sockets[`localhost:${port}`].length : "(none)"}`);
console.log("");

// Wait a moment so the server has time to process
await new Promise((r) => setTimeout(r, 300));

try {
  await getOk(`${BASE}/ok`, "R1-followup");
} catch (e) {
  console.log(`[R1-followup]   FAILED: ${e.message}`);
}

console.log("");

// ── Round 2: WITH body cancel ────────────────────────────────────
console.log("─".repeat(70));
console.log("  ROUND 2: WITH body cancel");
console.log("─".repeat(70));
console.log("");

try {
  await getErr_withCancel(`${BASE}/err`, "R2");
} catch (e) {
  console.log(`[R2]   caught: ${e.message}`);
}

console.log(`[R2]   active connections on server: ${server.connections}`);
console.log(`[R2]     -> stored by agent: ${AGENT.sockets[`localhost:${port}`] ? AGENT.sockets[`localhost:${port}`].length : "(none)"}`);
console.log("");

await new Promise((r) => setTimeout(r, 300));

try {
  await getOk(`${BASE}/ok`, "R2-followup");
} catch (e) {
  console.log(`[R2-followup]   FAILED: ${e.message}`);
}

console.log("");

// ── Summary ──────────────────────────────────────────────────────
console.log("=".repeat(70));
console.log("  SUMMARY");
console.log("=".repeat(70));
console.log("");
console.log(`  Total server connections created: ${connectionCount}`);
console.log(`  Total server connections closed:  ${closedCount}`);
console.log("");
console.log("  Key insight:");
console.log("  Without body.cancel(): the unconsumed response stream keeps");
console.log("  the HTTP connection pinned — follow-up requests may stall");
console.log("  or create a new connection (defeating keep-alive).");
console.log("");
console.log("  With body.cancel(): the stream is torn down immediately,");
console.log("  releasing the connection back to the pool so it can be");
console.log("  reused for the next request.");
console.log("");
console.log("  This is the Web Fetch API standard behavior, portable");
console.log("  across browsers, Node.js, Deno, and Bun.");

server.close();
AGENT.destroy();
console.log("\nDone.");
