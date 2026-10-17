import { EventEmitter, once } from "node:events";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { expectDefined } from "@openclaw/normalization-core";
import { WebSocket, WebSocketServer } from "openclaw/plugin-sdk/websocket-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../runtime-api.js";
import {
  createMattermostConnectOnce,
  type MattermostWebSocketFactory,
} from "./monitor-websocket.js";
import { runWithReconnect } from "./reconnect.js";

class FakeWebSocket extends EventEmitter implements ReturnType<MattermostWebSocketFactory> {
  readonly sent: string[] = [];
  pingCalls = 0;
  closeCalls = 0;
  terminateCalls = 0;
  ping(): void {
    this.pingCalls++;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closeCalls++;
  }
  terminate(): void {
    this.terminateCalls++;
  }
  emitClose(code: number, reason = ""): void {
    this.emit("close", code, Buffer.from(reason, "utf8"));
  }
}

const testRuntime = (): RuntimeEnv => ({
  log: vi.fn(),
  error: vi.fn(),
  exit: (code: number): never => {
    throw new Error(`exit ${code}`);
  },
});

function createConnection(
  socket: FakeWebSocket | undefined,
  options: Partial<Parameters<typeof createMattermostConnectOnce>[0]> = {},
) {
  return createMattermostConnectOnce({
    wsUrl: "wss://example.invalid/api/v4/websocket",
    botToken: "token",
    runtime: testRuntime(),
    nextSeq: () => 1,
    onPosted: async () => {},
    ...(socket ? { webSocketFactory: () => socket } : {}),
    ...options,
  });
}

// Mirrors the server's acknowledgement of a valid authentication_challenge.
const authOkFrame = (seq: number): Buffer => encodeFrame({ status: "OK", seq_reply: seq });

async function startStalledWebSocketHandshakeServer(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const accepted: net.Socket[] = [];
  const server = net.createServer((socket) => {
    accepted.push(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}`,
    close: async () => {
      for (const socket of accepted) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

function sequence() {
  let seq = 1;
  return () => seq++;
}

function startAuthenticated(connect: () => Promise<void>, socket: FakeWebSocket) {
  const connected = connect();
  socket.emit("open");
  socket.emit("message", authOkFrame(1));
  return connected;
}

function startTimedMonitor(
  options: Partial<Parameters<typeof createMattermostConnectOnce>[0]> = {},
) {
  vi.useFakeTimers();
  const socket = new FakeWebSocket();
  const runtime = testRuntime();
  const connected = startAuthenticated(createConnection(socket, { runtime, ...options }), socket);
  return { socket, runtime, connected };
}

const encodeFrame = (payload: unknown) => Buffer.from(JSON.stringify(payload));
const postEnvelope = (post: Record<string, unknown>, event = "posted") =>
  JSON.stringify({ event, data: { post: JSON.stringify(post) } });

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

it("backs off across attempts when authentication never completes", async () => {
  const connectOnce = createConnection(undefined, {
    botToken: "revoked-token",
    nextSeq: sequence(),
    webSocketFactory: () => {
      const socket = new FakeWebSocket();
      queueMicrotask(() => {
        socket.emit("open");
        socket.emitClose(1006);
      });
      return socket;
    },
  });

  const connectErrors: string[] = [];
  const reconnectDelays: number[] = [];
  const abort = new AbortController();
  await runWithReconnect(connectOnce, {
    initialDelayMs: 10,
    maxDelayMs: 1000,
    jitterRatio: 0,
    abortSignal: abort.signal,
    onError: (err) => {
      expect(String(err)).toContain("bot token");
      expect(String(err)).toContain("connection dropped");
      connectErrors.push(err instanceof Error ? err.name : String(err));
      if (connectErrors.length === 3) {
        abort.abort();
      }
    },
    onReconnect: (delayMs) => reconnectDelays.push(delayMs),
  });

  expect(connectErrors).toEqual(
    Array.from({ length: 3 }, () => "WebSocketClosedBeforeAuthenticationError"),
  );
  expect(reconnectDelays).toEqual([10, 20]);
});

it("terminates the connection when the authentication reply never arrives", async () => {
  vi.useFakeTimers();
  const socket = new FakeWebSocket();
  const runtime = testRuntime();
  const connectOnce = createConnection(socket, {
    runtime,
  });

  const connected = connectOnce();
  socket.emit("open");

  await vi.advanceTimersByTimeAsync(29_999);
  expect(socket.terminateCalls).toBe(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(socket.terminateCalls).toBe(1);
  expect(runtime.error).toHaveBeenCalledWith(
    "mattermost websocket authentication timed out — reconnecting",
  );

  socket.emitClose(1006);
  await expect(connected).rejects.toMatchObject({
    name: "WebSocketClosedBeforeAuthenticationError",
  });
});

it("retries when first attempt errors before open and next attempt succeeds", async () => {
  const patches: Array<Record<string, unknown>> = [];
  const sockets: FakeWebSocket[] = [];

  const connectOnce = createConnection(undefined, {
    nextSeq: sequence(),
    statusSink: (patch) => {
      patches.push(patch as Record<string, unknown>);
    },
    webSocketFactory: () => {
      const socket = new FakeWebSocket();
      const attempt = sockets.length;
      sockets.push(socket);
      queueMicrotask(() => {
        if (attempt === 0) {
          socket.emit("error", new Error("boom"));
          socket.emitClose(1006, "connection refused");
          return;
        }
        socket.emit("open");
        expect(patches).not.toContainEqual(expect.objectContaining({ lifecycle: "ready" }));
        socket.emit("message", authOkFrame(1));
        expect(patches).toContainEqual(expect.objectContaining({ lifecycle: "ready" }));
        socket.emitClose(1000);
      });
      return socket;
    },
  });

  const firstAttempt = connectOnce();
  await expect(firstAttempt).rejects.toMatchObject({ name: "WebSocketClosedBeforeOpenError" });

  await connectOnce();

  expect(sockets).toHaveLength(2);
  const firstSocket = expectDefined(sockets[0], "first Mattermost socket");
  const secondSocket = expectDefined(sockets[1], "second Mattermost socket");
  expect(firstSocket.closeCalls).toBe(1);
  expect(secondSocket.sent).toHaveLength(1);
  expect(JSON.parse(expectDefined(secondSocket.sent[0], "Mattermost auth payload"))).toEqual({
    action: "authentication_challenge",
    data: { token: "token" },
    seq: 1,
  });
  expect(patches.filter((patch) => patch.connected === true).length).toBe(2);
  expect(patches.filter((patch) => patch.connected === false).length).toBe(3);
  expect(patches).toContainEqual(expect.objectContaining({ lifecycle: "starting" }));
  expect(patches).toContainEqual(expect.objectContaining({ lifecycle: "recovering" }));
});

it("accepts large valid post envelopes and rejects oversized websocket payloads", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP websocket server address");
  }

  const quotedCardBody = '"'.repeat(380_000);
  const largeProps = { cards: [{ body: quotedCardBody }] };
  const largePostEnvelope = postEnvelope({
    id: "post-large",
    message: "large Mattermost integration post",
    props: largeProps,
  });
  expect(JSON.stringify(largeProps).length).toBeLessThan(800_000);
  expect(Buffer.byteLength(largePostEnvelope)).toBeGreaterThan(1024 * 1024);
  expect(Buffer.byteLength(largePostEnvelope)).toBeLessThan(16 * 1024 * 1024);

  const runtime = testRuntime();
  const onPosted = vi.fn(async () => {});
  server.on("connection", (socket) => {
    socket.once("message", () => {
      socket.send(JSON.stringify({ status: "OK", seq_reply: 1 }));
      socket.send(postEnvelope({ id: "post-1", message: "normal Mattermost post" }));
      socket.send(largePostEnvelope);
      socket.send(Buffer.alloc(16 * 1024 * 1024 + 1, 0x78));
    });
  });

  try {
    await createConnection(undefined, {
      wsUrl: `ws://127.0.0.1:${address.port}`,
      runtime,
      nextSeq: () => 1,
      onPosted,
    })();
  } finally {
    server.close();
    await once(server, "close");
  }

  expect(onPosted).toHaveBeenCalledWith(expect.stringContaining('\\"id\\":\\"post-1\\"'));
  expect(onPosted).toHaveBeenCalledWith(expect.stringContaining('\\"id\\":\\"post-large\\"'));
  expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("Max payload size exceeded"));
});

it("dispatches reaction events to the reaction handler", async () => {
  const socket = new FakeWebSocket();
  const onPosted = vi.fn(async () => {});
  const onReaction = vi.fn(async (payload) => payload);
  const connectOnce = createConnection(socket, { onPosted, onReaction });
  const reaction = JSON.stringify({
    user_id: "user-1",
    post_id: "post-1",
    emoji_name: "thumbsup",
  });
  const payload = { event: "reaction_added", data: { reaction } };
  const connected = connectOnce();
  queueMicrotask(() => {
    socket.emit("open");
    socket.emit("message", authOkFrame(1));
    socket.emit("message", encodeFrame(payload));
    socket.emitClose(1000);
  });
  await connected;
  expect(onReaction).toHaveBeenCalledTimes(1);
  expect(onPosted).not.toHaveBeenCalled();
  expect(onReaction.mock.calls.at(0)?.[0]).toEqual(payload);
});

it("hands posted envelopes to ingress raw without duplicate decoding", async () => {
  const socket = new FakeWebSocket();
  const onPosted = vi.fn(async () => {});
  const connectOnce = createConnection(socket, {
    onPosted,
  });
  const post = { id: "post-raw", channel_id: "channel-raw", unexpected_transport_field: true };
  const raw = postEnvelope(post);
  const frame = Buffer.from(raw);
  const decode = vi.spyOn(frame, "toString");

  const connected = startAuthenticated(connectOnce, socket);
  socket.emit("message", Buffer.from(postEnvelope(post, "post_edited")));
  await new Promise<void>((resolve) => {
    queueMicrotask(resolve);
  });
  expect(onPosted).not.toHaveBeenCalled();
  socket.emit("message", frame);
  await vi.waitFor(() => {
    expect(onPosted).toHaveBeenCalledTimes(1);
  });
  socket.emitClose(1000);
  await connected;

  expect(onPosted).toHaveBeenCalledWith(raw);
  expect(decode.mock.calls.length).toBeLessThanOrEqual(1);
});

it("continues protocol keepalive when Mattermost responds with pong", async () => {
  const { socket, connected } = startTimedMonitor({ pingIntervalMs: 100, pongTimeoutMs: 25 });

  await vi.advanceTimersByTimeAsync(100);
  expect(socket.pingCalls).toBe(1);

  socket.emit("pong", Buffer.alloc(0));
  await vi.advanceTimersByTimeAsync(25);
  expect(socket.terminateCalls).toBe(0);

  await vi.advanceTimersByTimeAsync(75);
  expect(socket.pingCalls).toBe(2);

  socket.emitClose(1000);
  await connected;
});

it("terminates silent websocket drops when Mattermost misses pong timeout", async () => {
  let pollCount = 0;
  const { socket, runtime, connected } = startTimedMonitor({
    getBotUpdateAt: async () => {
      pollCount++;
      return 1000;
    },
    healthCheckIntervalMs: 100,
    pingIntervalMs: 50,
    pongTimeoutMs: 25,
  });

  await vi.advanceTimersByTimeAsync(0);
  expect(pollCount).toBe(1);

  await vi.advanceTimersByTimeAsync(50);
  expect(socket).toMatchObject({ pingCalls: 1, terminateCalls: 0 });

  await vi.advanceTimersByTimeAsync(25);
  expect(socket.terminateCalls).toBe(1);
  expect(runtime.error).toHaveBeenCalledWith("mattermost websocket pong timeout — reconnecting");

  await vi.advanceTimersByTimeAsync(500);
  expect(socket.pingCalls).toBe(1);
  expect(pollCount).toBe(1);

  socket.emitClose(1006);
  await connected;
});

it("does not terminate when getBotUpdateAt throws", async () => {
  const { socket, runtime, connected } = startTimedMonitor({
    getBotUpdateAt: vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(1000)
      .mockRejectedValue(new Error("network error")),
    healthCheckIntervalMs: 100,
  });

  await vi.advanceTimersByTimeAsync(0);

  await vi.advanceTimersByTimeAsync(100);
  expect(socket.terminateCalls).toBe(0);
  expect(runtime.error).toHaveBeenCalledWith(
    "mattermost: health check error: Error: network error",
  );

  socket.emitClose(1000);
  await connected;
});

it("keeps polling when the initial getBotUpdateAt call fails", async () => {
  const { socket, runtime, connected } = startTimedMonitor({
    getBotUpdateAt: vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValueOnce(1000)
      .mockResolvedValue(2000),
    healthCheckIntervalMs: 100,
  });

  await vi.advanceTimersByTimeAsync(0);
  expect(runtime.error).toHaveBeenCalledWith(
    "mattermost: failed to get initial update_at: Error: network error",
  );

  await vi.advanceTimersByTimeAsync(100);
  expect(socket.terminateCalls).toBe(0);

  await vi.advanceTimersByTimeAsync(100);
  expect(socket.terminateCalls).toBe(1);
  expect(runtime.log).toHaveBeenCalledWith(
    "mattermost: bot account updated (update_at changed: 1000 → 2000) — reconnecting",
  );

  socket.emitClose(1006);
  await connected;
});

it("does not overlap health checks when a prior poll is still running", async () => {
  const resolvers: Array<(value: number) => void> = [];
  let pollCount = 0;
  const { socket, connected } = startTimedMonitor({
    getBotUpdateAt: async () => {
      pollCount++;
      return await new Promise<number>((resolve) => {
        resolvers.push(resolve);
      });
    },
    healthCheckIntervalMs: 100,
  });

  await vi.advanceTimersByTimeAsync(0);
  expect(pollCount).toBe(1);

  await vi.advanceTimersByTimeAsync(300);
  expect(pollCount).toBe(1);

  resolvers[0]?.(1000);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(100);
  expect(pollCount).toBe(2);

  socket.emitClose(1000);
  await connected;
});

it("returns control to reconnect after a stalled handshake", async () => {
  const stalledServer = await startStalledWebSocketHandshakeServer();

  const runtime = testRuntime();
  const reconnectDelays: number[] = [];
  const connectErrors: string[] = [];
  const connectOnce = createConnection(undefined, {
    wsUrl: stalledServer.url,
    runtime,
    nextSeq: () => 1,
    webSocketFactory: (url, options) => {
      expect(options.handshakeTimeout).toBe(30_000);
      return new WebSocket(url, {
        ...options,
        handshakeTimeout: 200,
      }) as ReturnType<MattermostWebSocketFactory>;
    },
  });

  const abort = new AbortController();
  try {
    await runWithReconnect(connectOnce, {
      initialDelayMs: 50,
      maxDelayMs: 50,
      jitterRatio: 0,
      abortSignal: abort.signal,
      onError: (err) => {
        connectErrors.push(err instanceof Error ? err.name : String(err));
        if (connectErrors.length === 2) {
          abort.abort();
        }
      },
      onReconnect: (delayMs) => {
        reconnectDelays.push(delayMs);
      },
    });

    expect(connectErrors).toEqual([
      "WebSocketClosedBeforeOpenError",
      "WebSocketClosedBeforeOpenError",
    ]);
    expect(reconnectDelays).toEqual([50]);
  } finally {
    await stalledServer.close();
  }
});
