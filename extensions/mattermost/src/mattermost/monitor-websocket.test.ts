import { EventEmitter, once } from "node:events";
import net from "node:net";
import { expectDefined } from "@openclaw/normalization-core";
import { WebSocketServer } from "openclaw/plugin-sdk/websocket-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { listenOnLoopback } from "../../../test-support/hanging-loopback-server.js";
import type { RuntimeEnv } from "../../runtime-api.js";
import { createMattermostConnectOnce } from "./monitor-websocket.js";
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

function sequence() {
  let seq = 1;
  return () => seq++;
}

async function reconnectAttempts(connectOnce: () => Promise<void>, attempts: number) {
  const errors: unknown[] = [];
  const delays: number[] = [];
  const abort = new AbortController();
  await runWithReconnect(connectOnce, {
    abortSignal: abort.signal,
    onError: (error) => {
      errors.push(error);
      if (errors.length === attempts) {
        abort.abort();
      }
    },
    onReconnect: (delay) => delays.push(delay),
  });
  return {
    errors,
    names: errors.map((error) => (error instanceof Error ? error.name : String(error))),
    delays,
  };
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
const postEnvelope = (post: Record<string, unknown>, event = "posted") =>
  JSON.stringify({ event, data: { post: JSON.stringify(post) } });

beforeEach(() => {
  createWebSocket.mockReset();
  vi.useRealTimers();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("backs off across attempts when authentication never completes", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  createWebSocket.mockImplementation(() => {
    const socket = new FakeWebSocket();
    queueMicrotask(() => {
      socket.emit("open");
      socket.emitClose(1006);
    });
    return socket;
  });
  const { errors, names, delays } = await reconnectAttempts(
    createConnection(undefined, { botToken: "revoked-token", nextSeq: sequence() }),
    3,
  );
  for (const error of errors) {
    expect(String(error)).toContain("bot token");
    expect(String(error)).toContain("connection dropped");
  }
  expect(names).toEqual(
    Array.from({ length: 3 }, () => "WebSocketClosedBeforeAuthenticationError"),
  );
  expect(delays).toEqual([2000, 4000]);
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
  });
});

it("retries when first attempt errors before open and next attempt succeeds", async () => {
  const patches: Array<Record<string, unknown>> = [];
  const sockets: FakeWebSocket[] = [];

  createWebSocket.mockImplementation(() => {
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
  });
  const connectOnce = createConnection(undefined, {
    nextSeq: sequence(),
    statusSink: (patch) => {
      patches.push(patch as Record<string, unknown>);
    },
  });

  const firstAttempt = connectOnce();
  await expect(firstAttempt).rejects.toMatchObject({ name: "WebSocketClosedBeforeOpenError" });

  await connectOnce();

  expect(sockets).toHaveLength(2);
  const firstSocket = expectDefined(sockets[0], "first Mattermost socket");
  expect(firstSocket.closeCalls).toBe(1);
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
  const connected = startAuthenticated(connectOnce, socket);
  socket.emit("message", encodeFrame(payload));
  await closeConnection(socket, connected);
  expect(onReaction).toHaveBeenCalledExactlyOnceWith(payload);
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
  socket.emit("message", Buffer.from(postEnvelope(post, "post_edited")));
  await new Promise<void>((resolve) => {
    queueMicrotask(resolve);
  });
  expect(onPosted).not.toHaveBeenCalled();
  socket.emit("message", frame);
  await vi.waitFor(() => expect(onPosted).toHaveBeenCalledTimes(1));
  await closeConnection(socket, connected);

  expect(onPosted).toHaveBeenCalledWith(raw);
  expect(decode.mock.calls.length).toBeLessThanOrEqual(1);
});

it("continues protocol keepalive when Mattermost responds with pong", async () => {
  const { socket, connected } = startTimedMonitor();

  await vi.advanceTimersByTimeAsync(30_000);
  expect(socket.pingCalls).toBe(1);

  socket.emit("pong", Buffer.alloc(0));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(socket.terminateCalls).toBe(0);

  await vi.advanceTimersByTimeAsync(20_000);
  expect(socket.pingCalls).toBe(2);

  await closeConnection(socket, connected);
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

it.each([false, true])("keeps polling after health check failure (initial=%s)", async (initial) => {
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
  socket.ping = () => void socket.emit("pong", Buffer.alloc(0));

  await vi.advanceTimersByTimeAsync(0);
  if (initial) {
    expect(runtime.error).toHaveBeenCalledWith(
      "mattermost: failed to get initial update_at: Error: network error",
    );
  }
  await vi.advanceTimersByTimeAsync(30_000);
  expect(socket.terminateCalls).toBe(0);
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
  }
  await closeConnection(socket, connected, initial ? 1006 : 1000);
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
      2,
    );
    expect(names).toEqual(["WebSocketClosedBeforeOpenError", "WebSocketClosedBeforeOpenError"]);
    expect(delays).toEqual([2000]);
  } finally {
    await stalledServer.close();
  }
});
