// Real-TCP regression from Pick-cat's handshake proof, through the public adapter.
import { once } from "node:events";
import http from "node:http";
import type { Socket } from "node:net";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { listenOnLoopback } from "../../test-support/hanging-loopback-server.js";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import { runSignalSseLoop } from "./sse-reconnect.js";

async function createPeer() {
  const sockets = new Set<Socket>();
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
    if (attempt === 1) {
      return;
    }
    socket.off("end", endPendingUpgrade);
    wsServer.handleUpgrade(request, socket, head, (ws) => {
      ws.on("error", () => {});
      if (attempt === 2) {
        ws.send("private-inbound-message");
      }
      ws.send(JSON.stringify({ envelope: { timestamp: attempt } }));
      if (attempt === 2) {
        ws.close();
      }
    });
  });
  const port = await listenOnLoopback(server);
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    get attempts() {
      return attempts;
    },
    async close() {
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

it("reconnects after opening timeout and closure and receives subsequent events", async () => {
  const peer = await createPeer();
  const abort = new AbortController();
  const runtime = createRuntimeSpies();
  let stream: Promise<void> | undefined;
  try {
    const events: number[] = [];
    const statusSink = vi.fn();
    stream = runSignalSseLoop({
      baseUrl: peer.baseUrl,
      account: "+15550001111",
      transportKind: "container",
      timeoutMs: 250,
      abortSignal: abort.signal,
      runtime,
      policy: { initialMs: 1, maxMs: 1, factor: 1, jitter: 0 },
      statusSink,
      onEvent: (event) => {
        const message = JSON.parse(event.data ?? "{}") as { envelope: { timestamp: number } };
        events.push(message.envelope.timestamp);
        if (events.length === 2) {
          abort.abort();
        }
      },
    });
    void stream.catch(() => {});
    await vi.waitFor(() => expect(events).toEqual([2, 3]), { timeout: 3_000 });
    await stream;
    expect(peer.attempts).toBe(3);
    expect(statusSink).toHaveBeenCalledWith(expect.objectContaining({ lifecycle: "recovering" }));
    expect(
      runtime.error.mock.calls.filter(
        ([line]) => line === "[signal-ws] parse error: invalid JSON frame",
      ),
    ).toHaveLength(1);
    expect(runtime.error.mock.calls.flat().join("\n")).not.toContain("private-inbound-message");
  } finally {
    abort.abort();
    try {
      await stream;
    } finally {
      await peer.close();
    }
  }
});
