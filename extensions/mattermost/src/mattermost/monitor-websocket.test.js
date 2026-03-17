import { describe, expect, it, vi } from "vitest";
import {
  createMattermostConnectOnce,
  WebSocketClosedBeforeOpenError
} from "./monitor-websocket.js";
import { runWithReconnect } from "./reconnect.js";
class FakeWebSocket {
  constructor() {
    this.sent = [];
    this.closeCalls = 0;
    this.terminateCalls = 0;
    this.openListeners = [];
    this.messageListeners = [];
    this.closeListeners = [];
    this.errorListeners = [];
  }
  on(event, listener) {
    if (event === "open") {
      this.openListeners.push(listener);
      return;
    }
    if (event === "message") {
      this.messageListeners.push(listener);
      return;
    }
    if (event === "close") {
      this.closeListeners.push(listener);
      return;
    }
    this.errorListeners.push(listener);
  }
  send(data) {
    this.sent.push(data);
  }
  close() {
    this.closeCalls++;
  }
  terminate() {
    this.terminateCalls++;
  }
  emitOpen() {
    for (const listener of this.openListeners) {
      listener();
    }
  }
  emitMessage(data) {
    for (const listener of this.messageListeners) {
      void listener(data);
    }
  }
  emitClose(code, reason = "") {
    const buffer = Buffer.from(reason, "utf8");
    for (const listener of this.closeListeners) {
      listener(code, buffer);
    }
  }
  emitError(err) {
    for (const listener of this.errorListeners) {
      listener(err);
    }
  }
}
const testRuntime = () => ({
  log: vi.fn(),
  error: vi.fn(),
  exit: ((code) => {
    throw new Error(`exit ${code}`);
  })
});
describe("mattermost websocket monitor", () => {
  it("rejects when websocket closes before open", async () => {
    const socket = new FakeWebSocket();
    const connectOnce = createMattermostConnectOnce({
      wsUrl: "wss://example.invalid/api/v4/websocket",
      botToken: "token",
      runtime: testRuntime(),
      nextSeq: () => 1,
      onPosted: async () => {
      },
      webSocketFactory: () => socket
    });
    queueMicrotask(() => {
      socket.emitClose(1006, "connection refused");
    });
    const failure = connectOnce();
    await expect(failure).rejects.toBeInstanceOf(WebSocketClosedBeforeOpenError);
    await expect(failure).rejects.toMatchObject({
      message: "websocket closed before open (code 1006)"
    });
  });
  it("retries when first attempt errors before open and next attempt succeeds", async () => {
    const abort = new AbortController();
    const reconnectDelays = [];
    const onError = vi.fn();
    const patches = [];
    const sockets = [];
    let disconnects = 0;
    const connectOnce = createMattermostConnectOnce({
      wsUrl: "wss://example.invalid/api/v4/websocket",
      botToken: "token",
      runtime: testRuntime(),
      nextSeq: /* @__PURE__ */ (() => {
        let seq = 1;
        return () => seq++;
      })(),
      onPosted: async () => {
      },
      abortSignal: abort.signal,
      statusSink: (patch) => {
        patches.push(patch);
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
          socket.emitClose(1e3);
        });
        return socket;
      }
    });
    await runWithReconnect(connectOnce, {
      abortSignal: abort.signal,
      initialDelayMs: 1,
      onError,
      onReconnect: (delay) => reconnectDelays.push(delay)
    });
    expect(sockets).toHaveLength(2);
    expect(sockets[0].closeCalls).toBe(1);
    expect(sockets[1].sent).toHaveLength(1);
    expect(JSON.parse(sockets[1].sent[0])).toMatchObject({
      action: "authentication_challenge",
      data: { token: "token" },
      seq: 1
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(reconnectDelays).toEqual([1]);
    expect(patches.some((patch) => patch.connected === true)).toBe(true);
    expect(patches.filter((patch) => patch.connected === false)).toHaveLength(2);
  });
  it("dispatches reaction events to the reaction handler", async () => {
    const socket = new FakeWebSocket();
    const onPosted = vi.fn(async () => {
    });
    const onReaction = vi.fn(async (payload2) => payload2);
    const connectOnce = createMattermostConnectOnce({
      wsUrl: "wss://example.invalid/api/v4/websocket",
      botToken: "token",
      runtime: testRuntime(),
      nextSeq: () => 1,
      onPosted,
      onReaction,
      webSocketFactory: () => socket
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
                emoji_name: "thumbsup"
              })
            }
          })
        )
      );
      socket.emitClose(1e3);
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
          emoji_name: "thumbsup"
        })
      }
    });
    expect(payload.data?.reaction).toBe(
      JSON.stringify({
        user_id: "user-1",
        post_id: "post-1",
        emoji_name: "thumbsup"
      })
    );
    expect(payload.data?.reaction).toBeDefined();
  });
});
