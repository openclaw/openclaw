/**
 * Real behavior proof: ws library handshakeTimeout bounds stalled WebSocket
 * handshakes. Proves the library behavior the fix depends on.
 *
 * - Negative control: ws without handshakeTimeout hangs on stalled peer
 * - Positive control: ws with handshakeTimeout errors within budget
 * - Valid response: ws with handshakeTimeout connects normally
 */
import net from "node:net";
import WebSocket, { WebSocketServer } from "ws";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

function assert(description: string, fn: () => boolean) {
  try {
    if (fn()) {
      passed++;
      console.log("  ok: %s", description);
    } else {
      failed++;
      console.log("  FAIL: %s", description);
    }
  } catch (err) {
    failed++;
    console.log("  FAIL: %s — %s", description, (err as Error).message);
  }
}

async function listenLoopback(server: net.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("server failed to bind");
  return addr.port;
}

async function main() {
  // -------------------------------------------------------------------------
  // [case 1] Negative — no handshakeTimeout, hangs >500ms on stalled peer
  // -------------------------------------------------------------------------
  console.log("[case 1] negative control — ws without handshakeTimeout");
  {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((s) => {
      sockets.add(s);
      s.once("close", () => sockets.delete(s));
    });
    const port = await listenLoopback(server);

    const startedAt = Date.now();
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { maxPayload: 1024 * 1024 });
    const outcome = await Promise.race([
      new Promise<"error">((r) => {
        ws.once("error", () => r("error"));
      }),
      new Promise<"still-pending">((r) => {
        setTimeout(() => r("still-pending"), 500);
      }),
    ]);
    const elapsedMs = Date.now() - startedAt;

    assert(
      "without handshakeTimeout, ws stays pending after 500ms on stalled peer",
      () => outcome === "still-pending",
    );
    console.log("  info: outcome=%s elapsed_ms=%d", outcome, elapsedMs);

    ws.terminate();
    for (const s of sockets) s.destroy();
    server.close();
  }

  // -------------------------------------------------------------------------
  // [case 2] Positive — handshakeTimeout errors within budget on stalled peer
  // -------------------------------------------------------------------------
  console.log("[case 2] positive control — ws with handshakeTimeout=300");
  {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((s) => {
      sockets.add(s);
      s.once("close", () => sockets.delete(s));
    });
    const port = await listenLoopback(server);
    const budgetMs = 300;

    const startedAt = Date.now();
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      maxPayload: 1024 * 1024,
      handshakeTimeout: budgetMs,
    });
    const error = await new Promise<Error>((resolve, reject) => {
      ws.once("error", resolve);
      setTimeout(() => reject(new Error("handshakeTimeout did not fire within 5s")), 5_000);
    });
    const elapsedMs = Date.now() - startedAt;

    assert("handshakeTimeout fires on stalled peer", () => error instanceof Error);
    console.log("  info: error_name=%s error_message=%s", error.name, error.message);
    assert("error fires within 10x budget", () => elapsedMs < budgetMs * 10);
    assert("error fires after at least 50ms", () => elapsedMs >= 50);
    console.log("  info: elapsed_ms=%d budget_ms=%d", elapsedMs, budgetMs);

    ws.terminate();
    for (const s of sockets) s.destroy();
    server.close();
  }

  // -------------------------------------------------------------------------
  // [case 3] Valid — handshakeTimeout doesn't block normal connections
  // -------------------------------------------------------------------------
  console.log("[case 3] valid server — ws with handshakeTimeout connects normally");
  {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((r) => wss.once("listening", r));
    const addr = wss.address();
    if (!addr || typeof addr === "string") throw new Error("wss failed to bind");

    const startedAt = Date.now();
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}`, {
      maxPayload: 1024 * 1024,
      handshakeTimeout: 30_000,
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    const elapsedMs = Date.now() - startedAt;

    assert(
      "handshakeTimeout does not block normal connections",
      () => ws.readyState === WebSocket.OPEN,
    );
    assert("normal connection completes quickly", () => elapsedMs < 5_000);
    console.log("  info: ready_state=%d elapsed_ms=%d", ws.readyState, elapsedMs);

    ws.close();
    await new Promise<void>((r) => wss.close(() => r()));
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log("");
  console.log("node=%s %s", process.version, process.arch);
  console.log("head=%s", process.env.GIT_HEAD ?? "unknown");
  console.log("ALL PROOF ASSERTIONS: %d passed, %d failed", passed, failed);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("proof crashed:", err);
  process.exit(1);
});
