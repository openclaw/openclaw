// Mattermost tests cover monitor websocket plugin behavior.
import { EventEmitter, once } from "node:events";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { expectDefined } from "@openclaw/normalization-core";
import { WebSocket, WebSocketServer } from "openclaw/plugin-sdk/websocket-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  emitOpen(): void {
    this.emit("open");
  }
  emitMessage(data: Buffer): void {
    this.emit("message", data);
  }
  emitPong(data = Buffer.alloc(0)): void {
    this.emit("pong", data);
  }
  emitClose(code: number, reason = ""): void {
    this.emit("close", code, Buffer.from(reason, "utf8"));
  }
  emitError(err: unknown): void {
    this.emit("error", err);
  }
}

const testRuntime = (): RuntimeEnv =>
  ({
    log: vi.fn(),
    error: vi.fn(),
    exit: ((code: number): never => {
      throw new Error(`exit ${code}`);
    }) as RuntimeEnv["exit"],
  }) as RuntimeEnv;

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
const authOkFrame = (seq: number): Buffer =>
  Buffer.from(JSON.stringify({ status: "OK", seq_reply: seq }));

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

function startAuthenticated(connect: () => Promise<void>, socket: FakeWebSocket) {
  const connected = connect();
  socket.emitOpen();
  socket.emitMessage(authOkFrame(1));
  return connected;
}

describe("mattermost websocket monitor", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("backs off across attempts when authentication never completes", async () => {
    const connectOnce = createConnection(undefined, {
      botToken: "revoked-token",
      nextSeq: (() => {
        let seq = 1;
        return () => seq++;
      })(),
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        queueMicrotask(() => {
          socket.emitOpen();
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

    // Every attempt fails authentication, so the delay doubles instead of resetting to the floor.
    expect(connectErrors).toEqual([
      "WebSocketClosedBeforeAuthenticationError",
      "WebSocketClosedBeforeAuthenticationError",
      "WebSocketClosedBeforeAuthenticationError",
    ]);
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
    socket.emitOpen();

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
    vi.useRealTimers();
  });

  it("retries when first attempt errors before open and next attempt succeeds", async () => {
    const patches: Array<Record<string, unknown>> = [];
    const sockets: FakeWebSocket[] = [];

    const connectOnce = createConnection(undefined, {
      nextSeq: (() => {
        let seq = 1;
        return () => seq++;
      })(),
      statusSink: (patch) => {
        patches.push(patch as Record<string, unknown>);
      },
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        const attempt = sockets.length;
        sockets.push(socket);
        queueMicrotask(() => {
          if (attempt === 0) {
            socket.emitError(new Error("boom"));
            socket.emitClose(1006, "connection refused");
            return;
          }
          socket.emitOpen();
          expect(patches).not.toContainEqual(expect.objectContaining({ lifecycle: "ready" }));
          socket.emitMessage(authOkFrame(1));
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
    const largePostEnvelope = JSON.stringify({
      event: "posted",
      data: {
        post: JSON.stringify({
          id: "post-large",
          message: "large Mattermost integration post",
          props: largeProps,
        }),
      },
    });
    expect(JSON.stringify(largeProps).length).toBeLessThan(800_000);
    expect(Buffer.byteLength(largePostEnvelope)).toBeGreaterThan(1024 * 1024);
    expect(Buffer.byteLength(largePostEnvelope)).toBeLessThan(16 * 1024 * 1024);

    const runtime = testRuntime();
    const onPosted = vi.fn(async () => {});
    server.on("connection", (socket) => {
      socket.once("message", () => {
        socket.send(JSON.stringify({ status: "OK", seq_reply: 1 }));
        socket.send(
          JSON.stringify({
            event: "posted",
            data: {
              post: JSON.stringify({ id: "post-1", message: "normal Mattermost post" }),
            },
          }),
        );
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

    // onPosted now receives the raw envelope; the post rides inside it as a
    // nested JSON string, so its fields appear escaped.
    expect(onPosted).toHaveBeenCalledWith(expect.stringContaining('\\"id\\":\\"post-1\\"'));
    expect(onPosted).toHaveBeenCalledWith(expect.stringContaining('\\"id\\":\\"post-large\\"'));
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Max payload size exceeded"),
    );
  });

  it("dispatches reaction events to the reaction handler", async () => {
    const socket = new FakeWebSocket();
    const onPosted = vi.fn(async () => {});
    const onReaction = vi.fn(async (payload) => payload);
    const connectOnce = createConnection(socket, {
      onPosted,
      onReaction,
    });

    const connected = connectOnce();
    queueMicrotask(() => {
      socket.emitOpen();
      socket.emitMessage(authOkFrame(1));
      socket.emitMessage(
        Buffer.from(
          JSON.stringify({
            event: "reaction_added",
            data: {
              reaction: JSON.stringify({
                user_id: "user-1",
                post_id: "post-1",
                emoji_name: "thumbsup",
              }),
            },
          }),
        ),
      );
      socket.emitClose(1000);
    });

    await connected;

    expect(onReaction).toHaveBeenCalledTimes(1);
    expect(onPosted).not.toHaveBeenCalled();
    const reaction = JSON.stringify({
      user_id: "user-1",
      post_id: "post-1",
      emoji_name: "thumbsup",
    });
    const payload = onReaction.mock.calls.at(0)?.[0];
    expect(payload).toEqual({
      event: "reaction_added",
      data: { reaction },
    });
  });

  it("hands posted envelopes to ingress raw without duplicate decoding", async () => {
    const socket = new FakeWebSocket();
    const onPosted = vi.fn(async () => {});
    const connectOnce = createConnection(socket, {
      onPosted,
    });
    const posted = {
      event: "posted",
      data: {
        post: JSON.stringify({
          id: "post-raw",
          channel_id: "channel-raw",
          unexpected_transport_field: true,
        }),
      },
    };
    const raw = JSON.stringify(posted);
    const frame = Buffer.from(raw);
    const decode = vi.spyOn(frame, "toString");

    const connected = startAuthenticated(connectOnce, socket);
    socket.emitMessage(
      Buffer.from(
        JSON.stringify({
          ...posted,
          event: "post_edited",
        }),
      ),
    );
    await new Promise<void>((resolve) => {
      queueMicrotask(resolve);
    });
    expect(onPosted).not.toHaveBeenCalled();
    socket.emitMessage(frame);
    await vi.waitFor(() => {
      expect(onPosted).toHaveBeenCalledTimes(1);
    });
    socket.emitClose(1000);
    await connected;

    expect(onPosted).toHaveBeenCalledWith(raw);
    expect(decode.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("continues protocol keepalive when Mattermost responds with pong", async () => {
    vi.useFakeTimers();
    const socket = new FakeWebSocket();
    const connectOnce = createConnection(socket, { pingIntervalMs: 100, pongTimeoutMs: 25 });

    const connected = startAuthenticated(connectOnce, socket);

    await vi.advanceTimersByTimeAsync(100);
    expect(socket.pingCalls).toBe(1);

    socket.emitPong();
    await vi.advanceTimersByTimeAsync(25);
    expect(socket.terminateCalls).toBe(0);

    await vi.advanceTimersByTimeAsync(75);
    expect(socket.pingCalls).toBe(2);

    socket.emitClose(1000);
    await connected;
    vi.useRealTimers();
  });

  it("terminates silent websocket drops when Mattermost misses pong timeout", async () => {
    vi.useFakeTimers();
    const socket = new FakeWebSocket();
    const runtime = testRuntime();
    let pollCount = 0;
    const connectOnce = createConnection(socket, {
      runtime,
      getBotUpdateAt: async () => {
        pollCount++;
        return 1000;
      },
      healthCheckIntervalMs: 100,
      pingIntervalMs: 50,
      pongTimeoutMs: 25,
    });

    const connected = startAuthenticated(connectOnce, socket);

    await vi.advanceTimersByTimeAsync(0);
    expect(pollCount).toBe(1);

    await vi.advanceTimersByTimeAsync(50);
    expect(socket.pingCalls).toBe(1);
    expect(socket.terminateCalls).toBe(0);

    await vi.advanceTimersByTimeAsync(25);
    expect(socket.terminateCalls).toBe(1);
    expect(runtime.error).toHaveBeenCalledWith("mattermost websocket pong timeout — reconnecting");

    await vi.advanceTimersByTimeAsync(500);
    expect(socket.pingCalls).toBe(1);
    expect(pollCount).toBe(1);

    socket.emitClose(1006);
    await connected;
    vi.useRealTimers();
  });

  it("does not terminate when getBotUpdateAt throws", async () => {
    vi.useFakeTimers();
    const socket = new FakeWebSocket();
    const runtime = testRuntime();
    let shouldThrow = false;
    const connectOnce = createConnection(socket, {
      runtime,
      getBotUpdateAt: async () => {
        if (shouldThrow) {
          throw new Error("network error");
        }
        return 1000;
      },
      healthCheckIntervalMs: 100,
    });

    const connected = startAuthenticated(connectOnce, socket);

    await vi.advanceTimersByTimeAsync(0);

    // API error — should log but not terminate
    shouldThrow = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(socket.terminateCalls).toBe(0);
    expect(runtime.error).toHaveBeenCalledWith(
      "mattermost: health check error: Error: network error",
    );

    socket.emitClose(1000);
    await connected;
    vi.useRealTimers();
  });

  it("keeps polling when the initial getBotUpdateAt call fails", async () => {
    vi.useFakeTimers();
    const socket = new FakeWebSocket();
    const runtime = testRuntime();
    const responses: Array<number | Error> = [new Error("network error"), 1000, 2000];
    const connectOnce = createConnection(socket, {
      runtime,
      getBotUpdateAt: async () => {
        const next = responses.shift();
        if (next instanceof Error) {
          throw next;
        }
        return next ?? 2000;
      },
      healthCheckIntervalMs: 100,
    });

    const connected = startAuthenticated(connectOnce, socket);

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
    vi.useRealTimers();
  });

  it("does not overlap health checks when a prior poll is still running", async () => {
    vi.useFakeTimers();
    const socket = new FakeWebSocket();
    const resolvers: Array<(value: number) => void> = [];
    let pollCount = 0;
    const connectOnce = createConnection(socket, {
      getBotUpdateAt: async () => {
        pollCount++;
        return await new Promise<number>((resolve) => {
          resolvers.push(resolve);
        });
      },
      healthCheckIntervalMs: 100,
    });

    const connected = startAuthenticated(connectOnce, socket);

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
    vi.useRealTimers();
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

      // attempt 0 times out → reconnect; attempt 1 times out → stop.
      expect(connectErrors).toEqual([
        "WebSocketClosedBeforeOpenError",
        "WebSocketClosedBeforeOpenError",
      ]);
      expect(reconnectDelays).toEqual([50]);
      console.log(
        `[mattermost handshake reconnect proof] timeout_then_reconnect=true errors=${connectErrors.join(",")} reconnect_delays_ms=${reconnectDelays.join(",")}`,
      );
    } finally {
      await stalledServer.close();
    }
  });
});
