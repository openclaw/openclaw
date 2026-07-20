// Qqbot tests cover gateway connection close/disconnect status behavior.
import { EventEmitter } from "node:events";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineAdapters } from "../adapter/index.js";
import { saveSession } from "../session/session-store.js";
import { MAX_RECONNECT_ATTEMPTS } from "./constants.js";
import { GatewayConnection } from "./gateway-connection.js";
import type { QueuedMessage } from "./message-queue.js";
import type { GatewayAccount, GatewayPluginRuntime } from "./types.js";

const createQQWSClientMock = vi.hoisted(() => vi.fn());

vi.mock("./ws-client.js", () => ({
  createQQWSClient: createQQWSClientMock,
}));

vi.mock("../messaging/sender.js", () => ({
  getAccessToken: vi.fn(async () => "test-token"),
  getGatewayUrl: vi.fn(async () => "wss://mock-gateway"),
  getPluginUserAgent: vi.fn(() => "test-agent"),
  startBackgroundTokenRefresh: vi.fn(),
  stopBackgroundTokenRefresh: vi.fn(),
  clearTokenCache: vi.fn(),
}));

vi.mock("../session/session-store.js", () => ({
  loadSession: vi.fn(() => undefined),
  saveSession: vi.fn(),
  clearSession: vi.fn(),
}));

vi.mock("../session/known-users.js", () => ({
  recordKnownUser: vi.fn(),
  flushKnownUsers: vi.fn(),
}));

vi.mock("../ref/store.js", () => ({
  flushRefIndex: vi.fn(),
}));

vi.mock("../commands/slash-command-handler.js", () => ({
  trySlashCommand: vi.fn(async () => "enqueue"),
}));

class FakeWebSocket extends EventEmitter {
  readyState = 3; // CLOSED — keeps cleanup() from re-entering close()
  close = vi.fn();
  send = vi.fn();
}

function makeAccount(): GatewayAccount {
  return {
    accountId: "test-account",
    appId: "test-app",
    clientSecret: "test-secret",
    markdownSupport: false,
    config: {},
  };
}

async function startConnection(params: { onDisconnected?: (info: unknown) => void }) {
  const ws = new FakeWebSocket();
  createQQWSClientMock.mockResolvedValue(ws);
  const controller = new AbortController();
  const connection = new GatewayConnection({
    account: makeAccount(),
    abortSignal: controller.signal,
    cfg: {},
    runtime: {} as GatewayPluginRuntime,
    adapters: {} as EngineAdapters,
    handleMessage: async () => {},
    onDisconnected: params.onDisconnected,
  });
  const started = connection.start();
  await vi.waitFor(() => {
    expect(createQQWSClientMock).toHaveBeenCalled();
  });
  return { ws, controller, started };
}

describe("GatewayConnection disconnect status", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    createQQWSClientMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("reports a fatal disconnect when the close code says the bot is banned", async () => {
    const onDisconnected = vi.fn();
    const { ws, controller, started } = await startConnection({ onDisconnected });

    ws.emit("close", 4915, Buffer.from(""));

    expect(onDisconnected).toHaveBeenCalledWith({ reason: "banned", fatal: true });
    controller.abort();
    await started;
  });

  it("reports a non-fatal disconnect on a transient close before reconnecting", async () => {
    const onDisconnected = vi.fn();
    const { ws, controller, started } = await startConnection({ onDisconnected });

    ws.emit("close", 1006, Buffer.from(""));

    expect(onDisconnected).toHaveBeenCalledWith({ reason: "close code 1006", fatal: false });
    controller.abort();
    await started;
  });

  it("reports a fatal disconnect when reconnect attempts are exhausted", async () => {
    const onDisconnected = vi.fn();
    const sockets = Array.from({ length: MAX_RECONNECT_ATTEMPTS + 1 }, () => new FakeWebSocket());
    let socketIndex = 0;
    createQQWSClientMock.mockImplementation(async () => sockets[socketIndex++]);
    const controller = new AbortController();
    const connection = new GatewayConnection({
      account: makeAccount(),
      abortSignal: controller.signal,
      cfg: {},
      runtime: {} as GatewayPluginRuntime,
      adapters: {} as EngineAdapters,
      handleMessage: async () => {},
      onDisconnected,
    });
    const started = connection.start();
    await vi.waitFor(() => {
      expect(createQQWSClientMock).toHaveBeenCalledTimes(1);
    });

    for (let attempt = 0; attempt < MAX_RECONNECT_ATTEMPTS; attempt++) {
      expectDefined(sockets[attempt], `QQBot socket ${attempt}`).emit(
        "close",
        1006,
        Buffer.from(""),
      );
      await vi.runOnlyPendingTimersAsync();
      await vi.waitFor(() => {
        expect(createQQWSClientMock).toHaveBeenCalledTimes(attempt + 2);
      });
    }
    expectDefined(sockets[MAX_RECONNECT_ATTEMPTS], "final QQBot socket").emit(
      "close",
      1006,
      Buffer.from(""),
    );

    expect(onDisconnected).toHaveBeenCalledWith({
      reason: "reconnect attempts exhausted",
      fatal: true,
    });
    controller.abort();
    await started;
  });

  it("ignores a stale close from a superseded socket after a server-driven reconnect", async () => {
    const onDisconnected = vi.fn();
    const staleWs = new FakeWebSocket();
    const replacementWs = new FakeWebSocket();
    createQQWSClientMock.mockResolvedValueOnce(staleWs).mockResolvedValueOnce(replacementWs);
    const controller = new AbortController();
    const connection = new GatewayConnection({
      account: makeAccount(),
      abortSignal: controller.signal,
      cfg: {},
      runtime: {} as GatewayPluginRuntime,
      adapters: {} as EngineAdapters,
      handleMessage: async () => {},
      onDisconnected,
    });
    const started = connection.start();
    await vi.waitFor(() => {
      expect(createQQWSClientMock).toHaveBeenCalledTimes(1);
    });

    // Server asks for a reconnect: the old socket is torn down and a
    // replacement is scheduled, then becomes live.
    staleWs.emit("open");
    staleWs.emit("message", JSON.stringify({ op: 7 }));
    expect(onDisconnected).toHaveBeenCalledWith({
      reason: "server requested reconnect",
      fatal: false,
    });
    await vi.advanceTimersByTimeAsync(1_100);
    await vi.waitFor(() => {
      expect(createQQWSClientMock).toHaveBeenCalledTimes(2);
    });
    replacementWs.emit("open");

    // The superseded socket's close arrives late; it must not regress
    // the live replacement's status.
    staleWs.emit("close", 1000, Buffer.from(""));

    expect(onDisconnected).toHaveBeenCalledTimes(1);
    controller.abort();
    await started;
  });

  it("ignores a stale close while a server-driven reconnect is pending", async () => {
    const onDisconnected = vi.fn();
    const staleWs = new FakeWebSocket();
    const replacementWs = new FakeWebSocket();
    createQQWSClientMock.mockResolvedValueOnce(staleWs).mockResolvedValueOnce(replacementWs);
    const controller = new AbortController();
    const connection = new GatewayConnection({
      account: makeAccount(),
      abortSignal: controller.signal,
      cfg: {},
      runtime: {} as GatewayPluginRuntime,
      adapters: {} as EngineAdapters,
      handleMessage: async () => {},
      onDisconnected,
    });
    const started = connection.start();
    await vi.waitFor(() => {
      expect(createQQWSClientMock).toHaveBeenCalledTimes(1);
    });

    staleWs.emit("open");
    staleWs.emit("message", JSON.stringify({ op: 7 }));
    expect(onDisconnected).toHaveBeenCalledWith({
      reason: "server requested reconnect",
      fatal: false,
    });
    staleWs.emit("close", 1006, Buffer.from(""));

    expect(onDisconnected).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_100);
    await vi.waitFor(() => {
      expect(createQQWSClientMock).toHaveBeenCalledTimes(2);
    });

    controller.abort();
    await started;
  });

  it("reports a disconnect when the server invalidates the session", async () => {
    const onDisconnected = vi.fn();
    const { ws, controller, started } = await startConnection({ onDisconnected });

    ws.emit("open");
    ws.emit("message", JSON.stringify({ op: 9, d: false }));

    expect(onDisconnected).toHaveBeenCalledWith({
      reason: "session invalidated",
      fatal: false,
    });

    controller.abort();
    await started;
  });

  it("does not report a disconnect for the close caused by an intentional abort", async () => {
    const onDisconnected = vi.fn();
    const { ws, controller, started } = await startConnection({ onDisconnected });

    controller.abort();
    ws.emit("close", 1000, Buffer.from(""));

    expect(onDisconnected).not.toHaveBeenCalled();
    await started;
  });
});

describe("GatewayConnection resume watermark", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    createQQWSClientMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  async function startWatermarkConnection(handleMessage: (msg: QueuedMessage) => Promise<void>) {
    const ws = new FakeWebSocket();
    createQQWSClientMock.mockResolvedValue(ws);
    const controller = new AbortController();
    const connection = new GatewayConnection({
      account: makeAccount(),
      abortSignal: controller.signal,
      cfg: {},
      runtime: {} as GatewayPluginRuntime,
      adapters: {} as EngineAdapters,
      handleMessage,
    });
    const started = connection.start();
    await vi.waitFor(() => {
      expect(createQQWSClientMock).toHaveBeenCalled();
    });
    ws.emit("open");
    return { ws, controller, started };
  }

  function emitReady(ws: FakeWebSocket, seq: number) {
    ws.emit("message", JSON.stringify({ op: 0, t: "READY", s: seq, d: { session_id: "sess-1" } }));
  }

  function emitC2CMessage(ws: FakeWebSocket, seq: number, messageId: string) {
    ws.emit(
      "message",
      JSON.stringify({
        op: 0,
        t: "C2C_MESSAGE_CREATE",
        s: seq,
        d: {
          author: { user_openid: "user-1" },
          content: `msg ${messageId}`,
          id: messageId,
          timestamp: "2026-01-01T00:00:00Z",
        },
      }),
    );
  }

  function lastSavedSeq(): number | null | undefined {
    const calls = vi.mocked(saveSession).mock.calls;
    return calls.at(-1)?.[0]?.lastSeq;
  }

  // Regression: message seqs were committed (and persisted) at frame receipt,
  // before the queued handler ran, so a restart or reconnect RESUMEd past
  // queued/in-flight messages and permanently lost them.
  it("does not commit a message seq until its handler completes", async () => {
    let releaseHandler: () => void = () => {};
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const { ws, controller, started } = await startWatermarkConnection(() => handlerGate);

    emitReady(ws, 1);
    expect(lastSavedSeq()).toBe(1);

    emitC2CMessage(ws, 2, "m-inflight");
    // Let the slash-command gate resolve and enqueue the message.
    await vi.waitFor(() => {
      expect(lastSavedSeq()).toBe(1);
    });

    releaseHandler();
    await vi.waitFor(() => {
      expect(lastSavedSeq()).toBe(2);
    });

    controller.abort();
    await started;
  });

  it("resumes below an unprocessed message after a server-driven reconnect", async () => {
    const staleWs = new FakeWebSocket();
    const replacementWs = new FakeWebSocket();
    createQQWSClientMock.mockResolvedValueOnce(staleWs).mockResolvedValueOnce(replacementWs);
    const controller = new AbortController();
    const connection = new GatewayConnection({
      account: makeAccount(),
      abortSignal: controller.signal,
      cfg: {},
      runtime: {} as GatewayPluginRuntime,
      adapters: {} as EngineAdapters,
      // Handler never settles: the message stays in flight across reconnect.
      handleMessage: () => new Promise<void>(() => {}),
    });
    const started = connection.start();
    await vi.waitFor(() => {
      expect(createQQWSClientMock).toHaveBeenCalledTimes(1);
    });
    staleWs.emit("open");

    emitReady(staleWs, 1);
    emitC2CMessage(staleWs, 2, "m-unprocessed");
    await vi.waitFor(() => {
      expect(lastSavedSeq()).toBe(1);
    });

    // Heartbeats keep reporting the latest received frame seq (the receive
    // cursor) even though the resumable watermark is held below the
    // in-flight message.
    staleWs.readyState = 1; // OPEN — heartbeat only sends on a live socket
    staleWs.emit("message", JSON.stringify({ op: 10, d: { heartbeat_interval: 1_000 } }));
    await vi.advanceTimersByTimeAsync(1_000);
    const heartbeatFrame = staleWs.send.mock.calls
      .map((call) => JSON.parse(String(call[0])) as { op: number; d?: number | null })
      .find((frame) => frame.op === 1);
    expect(heartbeatFrame?.d).toBe(2);
    staleWs.readyState = 3;

    // Server-driven reconnect while the message handler is still running.
    staleWs.emit("message", JSON.stringify({ op: 7 }));
    await vi.advanceTimersByTimeAsync(1_100);
    await vi.waitFor(() => {
      expect(createQQWSClientMock).toHaveBeenCalledTimes(2);
    });
    replacementWs.emit("open");
    replacementWs.emit("message", JSON.stringify({ op: 10, d: { heartbeat_interval: 41_250 } }));

    const resumeFrame = replacementWs.send.mock.calls
      .map((call) => JSON.parse(String(call[0])) as { op: number; d?: { seq?: number } })
      .find((frame) => frame.op === 6);
    // RESUME must ask for replay from seq 1 so the gateway redelivers seq 2.
    expect(resumeFrame?.d?.seq).toBe(1);

    controller.abort();
    await started;
  });

  // A logged handler failure is a terminal drop (existing contract) and must
  // settle: the watermark is connection-wide, so a poison message that held
  // it would make every later reconnect replay already-successful traffic.
  it("settles a failed handler so it cannot pin the connection-wide watermark", async () => {
    const failed = new Set<string>();
    const staleWs = new FakeWebSocket();
    const replacementWs = new FakeWebSocket();
    createQQWSClientMock.mockResolvedValueOnce(staleWs).mockResolvedValueOnce(replacementWs);
    const controller = new AbortController();
    const connection = new GatewayConnection({
      account: makeAccount(),
      abortSignal: controller.signal,
      cfg: {},
      runtime: {} as GatewayPluginRuntime,
      adapters: {} as EngineAdapters,
      handleMessage: async (msg: QueuedMessage) => {
        if (msg.messageId === "m-poison") {
          failed.add(msg.messageId);
          throw new Error("handler blew up");
        }
      },
    });
    const started = connection.start();
    await vi.waitFor(() => {
      expect(createQQWSClientMock).toHaveBeenCalledTimes(1);
    });
    staleWs.emit("open");

    emitReady(staleWs, 1);
    // Failure-then-later-success: seq 2 fails terminally, seq 3 succeeds.
    emitC2CMessage(staleWs, 2, "m-poison");
    await vi.waitFor(() => {
      expect(failed.has("m-poison")).toBe(true);
    });
    emitC2CMessage(staleWs, 3, "m-after-failure");
    await vi.waitFor(() => {
      expect(lastSavedSeq()).toBe(3);
    });

    // Reconnect: RESUME resumes past both the failed and the succeeded
    // message — neither is replayed to any peer.
    staleWs.emit("message", JSON.stringify({ op: 7 }));
    await vi.advanceTimersByTimeAsync(1_100);
    await vi.waitFor(() => {
      expect(createQQWSClientMock).toHaveBeenCalledTimes(2);
    });
    replacementWs.emit("open");
    replacementWs.emit("message", JSON.stringify({ op: 10, d: { heartbeat_interval: 41_250 } }));

    const resumeFrame = replacementWs.send.mock.calls
      .map((call) => JSON.parse(String(call[0])) as { op: number; d?: { seq?: number } })
      .find((frame) => frame.op === 6);
    expect(resumeFrame?.d?.seq).toBe(3);

    controller.abort();
    await started;
  });

  it("advances the watermark when a full peer queue evicts a message", async () => {
    let releaseHandler: () => void = () => {};
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    // Only the first message ever completes; later drained messages hang so
    // the terminal watermark isolates the eviction-settle behavior.
    const { ws, controller, started } = await startWatermarkConnection((msg) =>
      msg.messageId === "m-0" ? handlerGate : new Promise<void>(() => {}),
    );

    emitReady(ws, 1);
    // First message occupies the handler; the per-peer queue (20) fills
    // behind it, and one more message evicts the oldest queued entry.
    for (let i = 0; i < 22; i += 1) {
      emitC2CMessage(ws, 2 + i, `m-${i}`);
    }
    await vi.waitFor(() => {
      expect(lastSavedSeq()).toBe(1);
    });

    releaseHandler();
    // Handler completion settles seq 2; the evicted seq 3 settled on drop,
    // so the watermark lands on 3 while seqs 4+ stay pending in the queue.
    await vi.waitFor(() => {
      expect(lastSavedSeq()).toBe(3);
    });

    controller.abort();
    await started;
  });
});
