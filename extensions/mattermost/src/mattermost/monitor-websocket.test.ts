import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../runtime-api.js";
import {
  createMattermostConnectOnce,
  type MattermostWebSocketLike,
  WebSocketClosedBeforeOpenError,
} from "./monitor-websocket.js";
import { runWithReconnect } from "./reconnect.js";

class FakeWebSocket implements MattermostWebSocketLike {
  public readonly sent: string[] = [];
  public closeCalls = 0;
  public terminateCalls = 0;
  public ping = vi.fn();
  private openListeners: Array<() => void> = [];
  private messageListeners: Array<(data: Buffer) => void | Promise<void>> = [];
  private closeListeners: Array<(code: number, reason: Buffer) => void> = [];
  private errorListeners: Array<(err: unknown) => void> = [];
  private pongListeners: Array<() => void> = [];

  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: Buffer) => void | Promise<void>): void;
  on(event: "close", listener: (code: number, reason: Buffer) => void): void;
  on(event: "error", listener: (err: unknown) => void): void;
  on(event: "pong", listener: () => void): void;
  on(event: "open" | "message" | "close" | "error" | "pong", listener: unknown): void {
    if (event === "open") {
      this.openListeners.push(listener as () => void);
      return;
    }
    if (event === "message") {
      this.messageListeners.push(listener as (data: Buffer) => void | Promise<void>);
      return;
    }
    if (event === "close") {
      this.closeListeners.push(listener as (code: number, reason: Buffer) => void);
      return;
    }
    if (event === "pong") {
      this.pongListeners.push(listener as () => void);
      return;
    }
    this.errorListeners.push(listener as (err: unknown) => void);
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
    for (const listener of this.openListeners) {
      listener();
    }
  }

  emitMessage(data: Buffer): void {
    for (const listener of this.messageListeners) {
      void listener(data);
    }
  }

  emitClose(code: number, reason = ""): void {
    const buffer = Buffer.from(reason, "utf8");
    for (const listener of this.closeListeners) {
      listener(code, buffer);
    }
  }

  emitPong(): void {
    for (const listener of this.pongListeners) {
      listener();
    }
  }

  emitError(err: unknown): void {
    for (const listener of this.errorListeners) {
      listener(err);
    }
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

describe("mattermost websocket monitor", () => {
  it("rejects when websocket closes before open", async () => {
    const socket = new FakeWebSocket();
    const connectOnce = createMattermostConnectOnce({
      wsUrl: "wss://example.invalid/api/v4/websocket",
      botToken: "token",
      runtime: testRuntime(),
      nextSeq: () => 1,
      onPosted: async () => {},
      webSocketFactory: () => socket,
    });

    queueMicrotask(() => {
      socket.emitClose(1006, "connection refused");
    });

    const failure = connectOnce();
    await expect(failure).rejects.toBeInstanceOf(WebSocketClosedBeforeOpenError);
    await expect(failure).rejects.toMatchObject({
      message: "websocket closed before open (code 1006)",
    });
  });

  it("retries when first attempt errors before open and next attempt succeeds", async () => {
    const abort = new AbortController();
    const reconnectDelays: number[] = [];
    const onError = vi.fn();
    const patches: Array<Record<string, unknown>> = [];
    const sockets: FakeWebSocket[] = [];
    let disconnects = 0;

    const connectOnce = createMattermostConnectOnce({
      wsUrl: "wss://example.invalid/api/v4/websocket",
      botToken: "token",
      runtime: testRuntime(),
      nextSeq: (() => {
        let seq = 1;
        return () => seq++;
      })(),
      onPosted: async () => {},
      abortSignal: abort.signal,
      statusSink: (patch) => {
        patches.push(patch as Record<string, unknown>);
        if (patch.lastDisconnect) {
          disconnects++;
          if (disconnects >= 2) {
            abort.abort();
          }
        }
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
          socket.emitClose(1000);
        });
        return socket;
      },
    });

    await runWithReconnect(connectOnce, {
      abortSignal: abort.signal,
      initialDelayMs: 1,
      onError,
      onReconnect: (delay) => reconnectDelays.push(delay),
    });

    expect(sockets).toHaveLength(2);
    expect(sockets[0].closeCalls).toBe(1);
    expect(sockets[1].sent).toHaveLength(1);
    expect(JSON.parse(sockets[1].sent[0])).toMatchObject({
      action: "authentication_challenge",
      data: { token: "token" },
      seq: 1,
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(reconnectDelays).toEqual([1]);
    expect(patches.some((patch) => patch.connected === true)).toBe(true);
    expect(patches.filter((patch) => patch.connected === false)).toHaveLength(2);
  });

  it("dispatches reaction events to the reaction handler", async () => {
    const socket = new FakeWebSocket();
    const onPosted = vi.fn(async () => {});
    const onReaction = vi.fn(async (payload) => payload);
    const connectOnce = createMattermostConnectOnce({
      wsUrl: "wss://example.invalid/api/v4/websocket",
      botToken: "token",
      runtime: testRuntime(),
      nextSeq: () => 1,
      onPosted,
      onReaction,
      webSocketFactory: () => socket,
    });

    const connected = connectOnce();
    queueMicrotask(() => {
      socket.emitOpen();
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
    const payload = onReaction.mock.calls[0]?.[0];
    expect(payload).toMatchObject({
      event: "reaction_added",
      data: {
        reaction: JSON.stringify({
          user_id: "user-1",
          post_id: "post-1",
          emoji_name: "thumbsup",
        }),
      },
    });
    expect(payload.data?.reaction).toBe(
      JSON.stringify({
        user_id: "user-1",
        post_id: "post-1",
        emoji_name: "thumbsup",
      }),
    );
    expect(payload.data?.reaction).toBeDefined();
  });

  it("terminates connection when pong times out", async () => {
    vi.useFakeTimers();
    const socket = new FakeWebSocket();
    const runtime = testRuntime();
    const connectOnce = createMattermostConnectOnce({
      wsUrl: "wss://example.invalid/api/v4/websocket",
      botToken: "token",
      runtime,
      nextSeq: () => 1,
      onPosted: async () => {},
      webSocketFactory: () => socket,
      pingIntervalMs: 100,
      pongTimeoutMs: 50,
    });

    const connected = connectOnce();
    socket.emitOpen();

    // Advance past ping interval to trigger a ping
    vi.advanceTimersByTime(100);
    expect(socket.ping).toHaveBeenCalledTimes(1);

    // Advance past pong timeout without sending pong
    vi.advanceTimersByTime(50);
    expect(socket.terminateCalls).toBe(1);
    expect(runtime.error).toHaveBeenCalledWith(
      "mattermost websocket pong timeout — terminating connection",
    );

    // Close to settle the promise
    socket.emitClose(1006);
    await connected;
    vi.useRealTimers();
  });

  it("keeps connection alive when pong arrives in time", async () => {
    vi.useFakeTimers();
    const socket = new FakeWebSocket();
    const connectOnce = createMattermostConnectOnce({
      wsUrl: "wss://example.invalid/api/v4/websocket",
      botToken: "token",
      runtime: testRuntime(),
      nextSeq: () => 1,
      onPosted: async () => {},
      webSocketFactory: () => socket,
      pingIntervalMs: 100,
      pongTimeoutMs: 50,
    });

    const connected = connectOnce();
    socket.emitOpen();

    // Trigger ping
    vi.advanceTimersByTime(100);
    expect(socket.ping).toHaveBeenCalledTimes(1);

    // Respond with pong before timeout
    socket.emitPong();

    // Advance past what would have been the timeout
    vi.advanceTimersByTime(50);
    expect(socket.terminateCalls).toBe(0);

    // Clean close
    socket.emitClose(1000);
    await connected;
    vi.useRealTimers();
  });

  it("terminates connection when bot is deactivated via user_updated", async () => {
    const socket = new FakeWebSocket();
    const runtime = testRuntime();
    const connectOnce = createMattermostConnectOnce({
      wsUrl: "wss://example.invalid/api/v4/websocket",
      botToken: "token",
      runtime,
      nextSeq: () => 1,
      onPosted: async () => {},
      webSocketFactory: () => socket,
      botUserId: "bot-123",
    });

    const connected = connectOnce();
    queueMicrotask(() => {
      socket.emitOpen();
      socket.emitMessage(
        Buffer.from(
          JSON.stringify({
            event: "user_updated",
            data: {
              user: {
                id: "bot-123",
                delete_at: 1700000000000,
              },
            },
          }),
        ),
      );
      // terminate triggers close
      socket.emitClose(1006);
    });

    await connected;
    expect(socket.terminateCalls).toBe(1);
    expect(runtime.error).toHaveBeenCalledWith(
      "mattermost bot deactivated (user_updated delete_at !== 0) — terminating connection",
    );
  });
});
