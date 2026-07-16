/**
 * Real behavior proof: Signal containerCheck WebSocket handshake timeout.
 *
 * Proves that `containerCheck` with a real stalled TCP peer (accepts, never
 * completes HTTP upgrade) returns an error within the caller-chosen timeoutMs
 * rather than hanging indefinitely.
 *
 * Covers:
 * - Negative control: without handshakeTimeout, containerCheck hangs past watchdog
 * - Positive control: with handshakeTimeout, returns error within safeTimeoutMs
 * - Valid response: containerCheck works normally with a real WebSocket server
 */
import http, { type Server } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { containerCheck } from "./extensions/signal/src/client-container.js";

let passed = 0;
let failed = 0;

function assert(description: string, fn: () => boolean) {
  try {
    if (fn()) { passed++; console.log("  ok: %s", description); }
    else { failed++; console.log("  FAIL: %s", description); }
  } catch (err) {
    failed++;
    console.log("  FAIL: %s — %s", description, (err as Error).message);
  }
}

async function listenLoopback(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("bind failed");
  return addr.port;
}

async function closeServer(server: Server | http.Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 500);
    server.close(() => { clearTimeout(t); resolve(); });
  });
}

const WATCHDOG_MS = 800;
const PROBE_TIMEOUT_MS = 400;

// ---------------------------------------------------------------------------
// [case 1] Positive control — stalled handshake errors within safeTimeoutMs
// ---------------------------------------------------------------------------
console.log("[case 1] positive control - stalled WebSocket handshake errors within timeoutMs");

{
  // Single HTTP server handles both /v1/about (REST) and WebSocket upgrade.
  // On upgrade, accept the TCP connection but NEVER send HTTP 101 — the ws
  // library's handshakeTimeout must fire.
  const stalledServer = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ versions: ["v1"] }));
  });
  stalledServer.on("upgrade", (_req, _socket, _head) => {
    // Accept TCP, never send 101 Switching Protocols → stalled handshake.
  });
  const port = await listenLoopback(stalledServer);

  const startedAt = Date.now();
  const result = await containerCheck(
    `http://127.0.0.1:${port}`,
    PROBE_TIMEOUT_MS,
    "+14259798283",
  );
  const elapsedMs = Date.now() - startedAt;

  assert("returns ok:false for stalled handshake", () => result.ok === false);
  assert("error message includes WebSocket or timeout", () =>
    result.error != null &&
    (result.error.includes("WebSocket") || result.error.includes("timeout")),
  );
  assert(
    `resolved within ~${PROBE_TIMEOUT_MS}ms (got ${elapsedMs}ms)`,
    () => elapsedMs < WATCHDOG_MS,
  );
  console.log("  info: ok=%s error=%s elapsed_ms=%d", result.ok, result.error, elapsedMs);

  await closeServer(stalledServer);
}

// ---------------------------------------------------------------------------
// [case 2] Negative control — without handshakeTimeout, check hangs
// ---------------------------------------------------------------------------
console.log("\n[case 2] negative control - bare new WebSocket(url) hangs without handshakeTimeout");

{
  const stalledServer = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ versions: ["v1"] }));
  });
  stalledServer.on("upgrade", (_req, _socket, _head) => {});
  const port = await listenLoopback(stalledServer);

  // Bypass containerCheck and go straight to a bare WebSocket to simulate the
  // pre-fix state (no handshakeTimeout). The ws library defaults to no deadline.
  const bare = new WebSocket(`ws://127.0.0.1:${port}/v1/receive/%2B14259798283`);
  const startedAt = Date.now();

  const outcome = await Promise.race([
    new Promise<"open" | "error" | "close">((resolve) => {
      bare.once("open", () => resolve("open"));
      bare.once("error", () => resolve("error"));
      bare.once("close", () => resolve("close"));
    }),
    new Promise<"still-pending">((resolve) => {
      setTimeout(() => resolve("still-pending"), WATCHDOG_MS);
    }),
  ]);

  assert(
    `bare WebSocket stays pending after ${WATCHDOG_MS}ms (no handshakeTimeout)`,
    () => outcome === "still-pending",
  );
  console.log("  info: outcome=%s elapsed_ms=%d", outcome, Date.now() - startedAt);

  bare.close();
  await closeServer(stalledServer);
}

// ---------------------------------------------------------------------------
// [case 3] Valid response — containerCheck works with a real WebSocket server
// ---------------------------------------------------------------------------
console.log("\n[case 3] valid response - containerCheck succeeds with real WebSocket server");

{
  const httpServer = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ versions: ["v1"] }));
  });
  const wss = new WebSocketServer({ server: httpServer });
  wss.on("connection", (ws) => {
    ws.close(1000, "probe-ok");
  });
  const port = await listenLoopback(httpServer);

  const startedAt = Date.now();
  const result = await containerCheck(
    `http://127.0.0.1:${port}`,
    3000,
    "+14259798283",
  );
  const elapsedMs = Date.now() - startedAt;

  assert("returns ok:true with real WebSocket server", () => result.ok === true);
  assert("returns status 101 (switching protocols)", () => result.status === 101);
  assert("connected quickly (< 500ms)", () => elapsedMs < 500);
  console.log("  info: ok=%s status=%s elapsed_ms=%d", result.ok, result.status, elapsedMs);

  wss.close();
  await closeServer(httpServer);
}

// ---------------------------------------------------------------------------
console.log("\n=== Summary ===");
console.log("ALL PROOF ASSERTIONS: %d passed, %d failed", passed, failed);
if (failed > 0) process.exit(1);
