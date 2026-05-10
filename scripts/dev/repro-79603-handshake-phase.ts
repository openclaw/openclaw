// Standalone reproduction for #79603 — captures the new last-completed
// handshake phase log line emitted on a real Gateway WebSocket handshake
// failure. Wires the production `attachGatewayWsConnectionHandler` against
// a fresh HTTP + WebSocketServer, opens a raw WS, never sends `connect`,
// and lets the preauth handshake timeout fire.
//
// Run:
//   pnpm exec tsx scripts/dev/repro-79603-handshake-phase.ts
//
// Expected stdout includes a line that contains both `handshake timeout`
// and `phase=ws_upgrade_started` (the new diagnostic field).

import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket, WebSocketServer } from "ws";
import type { ResolvedGatewayAuth } from "../../src/gateway/auth.js";
import { attachGatewayWsConnectionHandler } from "../../src/gateway/server/ws-connection.js";
import type { GatewayWsClient } from "../../src/gateway/server/ws-types.js";

const HANDSHAKE_TIMEOUT_MS = 250;
const HANDSHAKE_GRACE_MS = 1500;

const capturedLines: string[] = [];
const originalWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
  const text =
    typeof chunk === "string"
      ? chunk
      : Buffer.isBuffer(chunk)
        ? chunk.toString("utf8")
        : String(chunk);
  if (text.includes("handshake timeout") || text.includes("closed before connect")) {
    capturedLines.push(text.trimEnd());
  }
  return originalWrite(chunk as never, ...(rest as []));
}) as typeof process.stderr.write;

function makeLogger(name: string) {
  const emit = (level: string) => (message: string, meta?: Record<string, unknown>) => {
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : "";
    process.stderr.write(`[${level}] ${name}: ${message}${metaStr}\n`);
  };
  return {
    debug: emit("debug"),
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
  } as never;
}

const clients = new Set<GatewayWsClient>();
const resolvedAuth: ResolvedGatewayAuth = { mode: "none", allowTailscale: false };
const httpServer = createServer((_req, res) => {
  res.writeHead(404);
  res.end();
});
const wss = new WebSocketServer({ server: httpServer });

attachGatewayWsConnectionHandler({
  wss,
  clients,
  preauthConnectionBudget: { release: () => {} } as never,
  port: 0,
  resolvedAuth,
  preauthHandshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
  gatewayMethods: [],
  events: [],
  refreshHealthSnapshot: async () => ({}) as never,
  logGateway: makeLogger("gateway"),
  logHealth: makeLogger("gateway/health"),
  logWsControl: makeLogger("gateway/ws"),
  extraHandlers: {},
  broadcast: () => {},
  buildRequestContext: () =>
    ({
      unsubscribeAllSessionEvents: () => {},
      nodeRegistry: { unregister: () => null, register: () => ({}) },
      nodeUnsubscribeAll: () => {},
    }) as never,
});

await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
const address = httpServer.address();
const port = typeof address === "object" && address ? address.port : 0;

process.stdout.write(`[repro] gateway listening on ws://127.0.0.1:${port}\n`);
process.stdout.write(`[repro] preauth handshake timeout = ${HANDSHAKE_TIMEOUT_MS}ms\n`);

const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
ws.on("message", (data) => {
  process.stdout.write(`[repro] received: ${data.toString().slice(0, 120)}\n`);
});
await new Promise<void>((resolve, reject) => {
  ws.once("open", () => resolve());
  ws.once("error", reject);
});
process.stdout.write("[repro] ws opened, idling so server's preauth timer fires...\n");

await sleep(HANDSHAKE_TIMEOUT_MS + HANDSHAKE_GRACE_MS);
ws.removeAllListeners();
ws.terminate();

process.stdout.write("\n========== captured log lines ==========\n");
for (const line of capturedLines) {
  process.stdout.write(`${line}\n`);
}
process.stdout.write("========================================\n\n");

const phaseLine = capturedLines.find((line) => line.includes("phase="));
if (!phaseLine) {
  process.stdout.write("[repro] FAIL: no phase=... line was captured\n");
  process.exit(1);
}
process.stdout.write(`[repro] OK: phase log emitted (${capturedLines.length} matching line(s))\n`);

wss.close();
httpServer.close();
process.exit(0);
