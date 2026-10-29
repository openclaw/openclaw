import { EventEmitter, once } from "node:events";
import net from "node:net";
import { WebSocketServer } from "openclaw/plugin-sdk/websocket-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { listenOnLoopback } from "../../../test-support/hanging-loopback-server.js";
import type { RuntimeEnv } from "../../runtime-api.js";
import { createMattermostConnectOnce, type MattermostEventPayload } from "./monitor-websocket.js";
import { runWithReconnect } from "./reconnect.js";

const createWebSocket = vi.hoisted(() => vi.fn());

vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:timers/promises")>()),
  setTimeout: async () => {},
}));

vi.mock("openclaw/plugin-sdk/websocket-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/websocket-runtime")>();
  return {
    ...actual,
    WebSocket: Object.assign(
      vi.fn(function (...args: ConstructorParameters<typeof actual.WebSocket>) {
        return createWebSocket(...args) ?? new actual.WebSocket(...args);
      }),
      actual.WebSocket,
    ),
  };
});

class FakeWebSocket extends EventEmitter {
  pingCalls = 0;
  closeCalls = 0;
  terminateCalls = 0;
  ping(): void {
    this.pingCalls++;
  }
  send(): void {}
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
  if (socket) {
    createWebSocket.mockReturnValue(socket);
  }
  return createMattermostConnectOnce({
    wsUrl: "wss://example.invalid/api/v4/websocket",
    botToken: "token",
    runtime: testRuntime(),
    nextSeq: () => 1,
    onPosted: async () => {},
    onReaction: async () => {},
    getBotUpdateAt: async () => 0,
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
  const port = await listenOnLoopback(server);
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

async function reconnectAttempts(connectOnce: () => Promise<void>, attempts: number) {
  const names: string[] = [];
  const delays: number[] = [];
  const abort = new AbortController();
  await runWithReconnect(connectOnce, {
    abortSignal: abort.signal,
    onError: (error) => {
      names.push(error instanceof Error ? error.name : String(error));
      if (names.length === attempts) {
        abort.abort();
      }
    },
    onReconnect: (delay) => delays.push(delay),
  });
  return { names, delays };
}

function startAuthenticated(connect: () => Promise<void>, socket: FakeWebSocket) {
  const connected = connect();
  socket.emit("open");
  socket.emit("message", authOkFrame(1));
  return connected;
}

function startTimedMonitor(
  options: Partial<Parameters<typeof createMattermostConnectOnce>[0]> = {},
  authenticate = true,
) {
  vi.useFakeTimers();
  const socket = new FakeWebSocket();
  const runtime = testRuntime();
  const connect = createConnection(socket, { runtime, ...options });
  const connected = authenticate ? startAuthenticated(connect, socket) : connect();
  if (!authenticate) {
    socket.emit("open");
  }
  return { socket, runtime, connected };
}

async function closeConnection(socket: FakeWebSocket, connected: Promise<void>, code = 1000) {
  socket.emitClose(code);
  await connected;
}

const encodeFrame = (payload: unknown) => Buffer.from(JSON.stringify(payload));
const postEnvelope = (post: Record<string, unknown>) =>
  JSON.stringify({ event: "posted", data: { post: JSON.stringify(post) } });

beforeEach(() => {
  createWebSocket.mockReset();
  vi.useRealTimers();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("terminates the connection when the authentication reply never arrives", async () => {
  const { socket, runtime, connected } = startTimedMonitor({}, false);
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
    message: expect.stringMatching(/bot token.*connection dropped/),
  });
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
  const statusSink = vi.fn();
  server.on("connection", (socket) => {
    socket.once("message", () => {
      expect(statusSink).toHaveBeenCalledWith({ connected: true, lifecycle: "starting" });
      expect(statusSink).not.toHaveBeenCalledWith(expect.objectContaining({ lifecycle: "ready" }));
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
      statusSink,
    })();
  } finally {
    server.close();
    await once(server, "close");
  }

  expect(onPosted).toHaveBeenCalledWith(expect.stringContaining('\\"id\\":\\"post-1\\"'));
  expect(onPosted).toHaveBeenCalledWith(expect.stringContaining('\\"id\\":\\"post-large\\"'));
  expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("Max payload size exceeded"));
  expect(statusSink).toHaveBeenCalledWith(expect.objectContaining({ lifecycle: "ready" }));
  expect(statusSink).toHaveBeenCalledWith(expect.objectContaining({ lifecycle: "recovering" }));
});

it("dispatches reaction, edit, delete and membership events to their handlers", async () => {
  const socket = new FakeWebSocket();
  const onPosted = vi.fn(async () => {});
  const onReaction = vi.fn(async (payload) => payload);
  const onSystemEvent = vi.fn<(payload: MattermostEventPayload) => Promise<void>>(async () => {});
  const connectOnce = createConnection(socket, { onPosted, onReaction, onSystemEvent });
  const reaction = { event: "reaction_added", data: { reaction: '{"emoji_name":"thumbsup"}' } };
  const connected = startAuthenticated(connectOnce, socket);
  socket.emit("message", encodeFrame(reaction));
  for (const event of ["post_edited", "post_deleted", "user_added", "user_removed", "typing"]) {
    socket.emit("message", encodeFrame({ event, data: { user_id: "user-1" } }));
  }
  await closeConnection(socket, connected);
  expect(onReaction).toHaveBeenCalledExactlyOnceWith(reaction);
  expect(onSystemEvent.mock.calls.map(([payload]) => payload.event)).toEqual([
    "post_edited",
    "post_deleted",
    "user_added",
    "user_removed",
  ]);
  expect(onPosted).not.toHaveBeenCalled();
});

it("hands posted envelopes to ingress raw without duplicate decoding", async () => {
  const socket = new FakeWebSocket();
  const onPosted = vi.fn(async () => {});
  const connectOnce = createConnection(socket, { onPosted });
  const post = { id: "post-raw", channel_id: "channel-raw", unexpected_transport_field: true };
  const raw = postEnvelope(post);
  const frame = Buffer.from(raw);
  const decode = vi.spyOn(frame, "toString");

  const connected = startAuthenticated(connectOnce, socket);
  socket.emit("message", frame);
  await vi.waitFor(() => expect(onPosted).toHaveBeenCalledTimes(1));
  await closeConnection(socket, connected);

  expect(onPosted).toHaveBeenCalledWith(raw);
  expect(decode.mock.calls.length).toBeLessThanOrEqual(1);
});

it("terminates silent websocket drops when Mattermost misses pong timeout", async () => {
  let pollCount = 0;
  const { socket, runtime, connected } = startTimedMonitor({
    getBotUpdateAt: async () => {
      pollCount++;
      return 1000;
    },
  });

  await vi.advanceTimersByTimeAsync(0);
  expect(pollCount).toBe(1);

  await vi.advanceTimersByTimeAsync(30_000);
  expect(socket).toMatchObject({ pingCalls: 1, terminateCalls: 0 });

  await vi.advanceTimersByTimeAsync(10_000);
  expect(socket.terminateCalls).toBe(1);
  expect(runtime.error).toHaveBeenCalledWith("mattermost websocket pong timeout — reconnecting");

  await vi.advanceTimersByTimeAsync(60_000);
  expect(socket.pingCalls).toBe(1);
  expect(pollCount).toBe(2);

  await closeConnection(socket, connected, 1006);
});

it.each([false, true])(
  "keeps polling and pinging after health check failure (initial=%s)",
  async (initial) => {
    const getBotUpdateAt = vi.fn<() => Promise<number>>();
    if (initial) {
      getBotUpdateAt
        .mockRejectedValueOnce(new Error("network error"))
        .mockResolvedValueOnce(1000)
        .mockResolvedValue(2000);
    } else {
      getBotUpdateAt.mockResolvedValueOnce(1000).mockRejectedValue(new Error("network error"));
    }
    const { socket, runtime, connected } = startTimedMonitor({ getBotUpdateAt });
    const ping = socket.ping.bind(socket);
    socket.ping = () => {
      ping();
      socket.emit("pong", Buffer.alloc(0));
    };

    await vi.advanceTimersByTimeAsync(0);
    if (initial) {
      expect(runtime.error).toHaveBeenCalledWith(
        "mattermost: failed to get initial update_at: Error: network error",
      );
    }
    await vi.advanceTimersByTimeAsync(30_000);
    expect(socket.terminateCalls).toBe(0);
    expect(socket.pingCalls).toBe(1);
    if (initial) {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(socket.terminateCalls).toBe(1);
      expect(runtime.log).toHaveBeenCalledWith(
        "mattermost: bot account updated (update_at changed: 1000 → 2000) — reconnecting",
      );
    } else {
      expect(runtime.error).toHaveBeenCalledWith(
        "mattermost: health check error: Error: network error",
      );
      await vi.advanceTimersByTimeAsync(10_000);
      expect(socket.terminateCalls).toBe(0);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(socket.pingCalls).toBe(2);
    }
    await closeConnection(socket, connected, initial ? 1006 : 1000);
  },
);

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
  });
  socket.ping = () => void socket.emit("pong", Buffer.alloc(0));

  await vi.advanceTimersByTimeAsync(0);
  expect(pollCount).toBe(1);

  await vi.advanceTimersByTimeAsync(90_000);
  expect(pollCount).toBe(1);

  resolvers[0]?.(1000);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(pollCount).toBe(2);

  await closeConnection(socket, connected);
});

it("returns control to reconnect after a stalled handshake", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  const stalledServer = await startStalledWebSocketHandshakeServer();

  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/websocket-runtime")>(
    "openclaw/plugin-sdk/websocket-runtime",
  );
  createWebSocket.mockImplementation((url, options) => {
    expect(options.handshakeTimeout).toBe(30_000);
    return new actual.WebSocket(url, { ...options, handshakeTimeout: 200 });
  });
  try {
    const { names, delays } = await reconnectAttempts(
      createConnection(undefined, { wsUrl: stalledServer.url }),
      3,
    );
    expect(names).toEqual(Array.from({ length: 3 }, () => "WebSocketClosedBeforeOpenError"));
    expect(delays).toEqual([2000, 4000]);
  } finally {
    await stalledServer.close();
  }
});
