import { once } from "node:events";
import http from "node:http";
import type { Duplex } from "node:stream";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { listenOnLoopback } from "../../test-support/hanging-loopback-server.js";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import { runSignalSseLoop } from "./sse-reconnect.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function roundTrip(socket: WebSocket) {
  const pong = once(socket, "pong");
  socket.ping();
  await pong;
}

it("recovers opening, closed and half-open receivers without timing out healthy or paused reads", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
  const ping = vi.spyOn(WebSocket.prototype, "ping");
  const server = http.createServer((_request, response) => response.end("ok"));
  const peer = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, autoPong: false });
  let pending: Duplex | undefined;
  const sockets: WebSocket[] = [];
  let attempts = 0;
  server.on("upgrade", (request, socket, head) => {
    const attempt = ++attempts;
    if (attempt === 1) {
      pending = socket;
      socket.once("end", () => socket.destroy());
      socket.resume();
      return;
    }
    peer.handleUpgrade(request, socket, head, (ws) => {
      sockets.push(ws);
      ws.on("error", () => {});
      if (attempt === 2) {
        ws.send("private-inbound-message");
      }
      if (attempt >= 4) {
        ws.on("ping", (data) => ws.pong(data));
      }
      ws.send(JSON.stringify({ envelope: { timestamp: attempt } }));
      if (attempt === 2) {
        ws.close();
      }
    });
  });
  const port = await listenOnLoopback(server);
  const abort = new AbortController();
  const runtime = createRuntimeSpies();
  const statusSink = vi.fn();
  const events: number[] = [];
  const stream = runSignalSseLoop({
    baseUrl: `http://127.0.0.1:${port}`,
    account: "+15550001111",
    transportKind: "container",
    timeoutMs: 250,
    abortSignal: abort.signal,
    runtime,
    statusSink,
    policy: { initialMs: 1, maxMs: 1, factor: 1, jitter: 0 },
    onEvent: (event) => {
      events.push(JSON.parse(event.data ?? "{}").envelope.timestamp);
    },
  });
  const count = (line: string) =>
    runtime.error.mock.calls.filter(([message]) => message === line).length;
  const heartbeat = "[signal-ws] heartbeat timed out; reconnecting";
  try {
    await vi.waitFor(() => expect(events).toEqual([2, 3]), { timeout: 3_000 });
    expect(pending?.destroyed).toBe(true);
    await vi.advanceTimersByTimeAsync(25_000);
    await roundTrip(sockets[1]!);
    await vi.advanceTimersByTimeAsync(25_000);
    await vi.waitFor(() => expect(events).toEqual([2, 3, 4]), { timeout: 3_000 });
    expect(statusSink).toHaveBeenCalledWith(
      expect.objectContaining({ lifecycle: "recovering", connected: false }),
    );
    expect(count("[signal-ws] parse error: invalid JSON frame")).toBe(1);
    expect(runtime.error.mock.calls.flat().join("\n")).not.toContain("private-inbound-message");
    await vi.advanceTimersByTimeAsync(25_000);
    await roundTrip(sockets[2]!);
    const receiver = ping.mock.contexts.find(
      (socket): socket is WebSocket =>
        socket instanceof WebSocket && Boolean(socket.url) && socket.readyState === WebSocket.OPEN,
    )!;
    receiver.pause();
    await vi.advanceTimersByTimeAsync(75_000);
    expect(count(heartbeat)).toBe(1);
    receiver.resume();
    await roundTrip(sockets[2]!);
    await vi.advanceTimersByTimeAsync(25_000);
    await roundTrip(sockets[2]!);
    expect(attempts).toBe(4);
    expect(count(heartbeat)).toBe(1);
  } finally {
    abort.abort();
    await stream;
    pending?.destroy();
    peer.clients.forEach((socket) => socket.terminate());
    await Promise.all([promisify(peer.close.bind(peer))(), promisify(server.close.bind(server))()]);
    expect(vi.getTimerCount()).toBe(0);
  }
});
