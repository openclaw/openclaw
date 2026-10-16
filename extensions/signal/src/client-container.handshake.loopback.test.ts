// Real-TCP regression from Pick-cat's handshake proof, through the public adapter.
import { once } from "node:events";
import http from "node:http";
import type { Socket } from "node:net";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import { runSignalSseLoop } from "./sse-reconnect.js";

const ACCOUNT = "+15550001111";
const BUDGET_MS = 250;

type Peer = Awaited<ReturnType<typeof createPeer>>;

async function createPeer(
  upgradeAfterMs: (attempt: number) => number | undefined,
  connected: (socket: WebSocket, attempt: number) => void,
) {
  const sockets = new Set<Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = http.createServer((_request, response) => response.end("ok"));
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  let attempts = 0;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket, head) => {
    const attempt = ++attempts;
    // Drain pending raw upgrade sockets so the peer observes the client's FIN.
    // HTTP hands ownership of these half-open sockets to the upgrade listener.
    const endPendingUpgrade = () => socket.destroy();
    socket.once("end", endPendingUpgrade);
    socket.resume();
    const waitMs = upgradeAfterMs(attempt);
    if (waitMs === undefined) {
      return;
    }
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (socket.destroyed) {
        return;
      }
      socket.off("end", endPendingUpgrade);
      wsServer.handleUpgrade(request, socket, head, (ws) => {
        ws.on("error", () => {});
        connected(ws, attempt);
      });
    }, waitMs);
    timers.add(timer);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected a TCP listening address");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    get attempts() {
      return attempts;
    },
    async close() {
      timers.forEach(clearTimeout);
      const socketClosed = [...sockets].map((socket) => once(socket, "close"));
      wsServer.clients.forEach((ws) => ws.terminate());
      sockets.forEach((socket) => socket.destroy());
      await Promise.all([
        ...socketClosed,
        promisify(wsServer.close.bind(wsServer))(),
        promisify(server.close.bind(server))(),
      ]);
      expect(sockets.size).toBe(0);
    },
  };
}

describe("container adapter opening budgets with real peers", () => {
  let peer: Peer | undefined;
  let abort: AbortController | undefined;
  let stream: Promise<void> | undefined;

  afterEach(async () => {
    abort?.abort();
    try {
      await stream;
    } finally {
      await peer?.close();
      peer = undefined;
      abort = undefined;
      stream = undefined;
    }
  });

  it("reconnects after opening timeout and closure and receives subsequent events", async () => {
    peer = await createPeer(
      (attempt) => (attempt === 1 ? undefined : 0),
      (ws, attempt) => {
        ws.send(JSON.stringify({ envelope: { timestamp: attempt } }));
        if (attempt === 2) {
          ws.close();
        }
      },
    );
    abort = new AbortController();
    const events: number[] = [];
    const statusSink = vi.fn();
    stream = runSignalSseLoop({
      baseUrl: peer.baseUrl,
      account: ACCOUNT,
      transportKind: "container",
      timeoutMs: BUDGET_MS,
      abortSignal: abort.signal,
      runtime: createRuntimeSpies(),
      policy: { initialMs: 1, maxMs: 1, factor: 1, jitter: 0 },
      statusSink,
      onEvent: (event) => {
        const message = JSON.parse(event.data ?? "{}") as { envelope: { timestamp: number } };
        events.push(message.envelope.timestamp);
        if (events.length === 2) {
          abort?.abort();
        }
      },
    });
    void stream.catch(() => {});
    await vi.waitFor(() => expect(events).toEqual([2, 3]), { timeout: 3_000 });
    await stream;
    expect(peer.attempts).toBe(3);
    expect(statusSink).toHaveBeenCalledWith(expect.objectContaining({ lifecycle: "recovering" }));
  });
});
