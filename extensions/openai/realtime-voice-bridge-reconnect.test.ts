// Openai tests cover realtime voice provider plugin behavior.
import type { RealtimeVoiceBridgeEvent } from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const mocks = await vi.hoisted(async () => {
  const { createOpenAIRealtimeMockState } = await import("./realtime-voice-test-support.js");
  return createOpenAIRealtimeMockState();
});
const { FakeWebSocket } = mocks;

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: mocks.execFileSyncMock,
  };
});

vi.mock("ws", () => ({
  default: mocks.FakeWebSocket,
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: mocks.fetchWithSsrFGuardMock,
}));

// mock-isolation: Reconnect tests control credential completion without host auth storage or refresh work.
vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  isProviderAuthProfileConfigured: mocks.isProviderAuthProfileConfiguredMock,
  isProviderAuthProfileConfiguredAsync: mocks.isProviderAuthProfileConfiguredMock,
  resolveProviderAuthProfileApiKey: mocks.resolveProviderAuthProfileApiKeyMock,
}));
import { createOpenAIRealtimeTestSupport } from "./realtime-voice-test-support.js";

const {
  parseSent,
  createNativeBridge,
  requireSocket,
  beginBridgeConnection,
  openSocket,
  emitServerEvent,
  emitSessionUpdated,
  emitCompletedToolCalls,
  emitFunctionOutputAdded,
  connectReadyBridge,
  resetTestState,
  restoreTestEnvironment,
  rejectedKeyMessage: OPENAI_REALTIME_REJECTED_KEY_MESSAGE,
} = createOpenAIRealtimeTestSupport({ ...mocks, buildOpenAIRealtimeVoiceProvider });

type Socket = ReturnType<typeof requireSocket>;

let onAudio: ReturnType<typeof vi.fn>;
let onClose: ReturnType<typeof vi.fn>;
let onError: ReturnType<typeof vi.fn>;
let onEvent: ReturnType<typeof vi.fn>;
let onReady: ReturnType<typeof vi.fn>;

function expectLifecycle(type: string, detail: string, direction = "client") {
  expect(onEvent).toHaveBeenCalledWith({ direction, type, detail });
}

function dropSocket(socket: Socket, reason = "transient drop") {
  socket.readyState = FakeWebSocket.CLOSED;
  socket.emit("close", 1006, Buffer.from(reason));
}

async function openRetry(socket: Socket) {
  dropSocket(socket);
  await vi.advanceTimersByTimeAsync(1000);
  const retrySocket = requireSocket(1);
  openSocket(retrySocket);
  return retrySocket;
}

function expireSession(socket: Socket) {
  emitServerEvent(socket, {
    type: "error",
    error: { message: "Your session hit the maximum duration of 60 minutes." },
  });
}

describe("OpenAI realtime voice bridge reconnect", () => {
  beforeEach(() => {
    resetTestState();
    onAudio = vi.fn();
    onClose = vi.fn();
    onError = vi.fn();
    onEvent = vi.fn();
    onReady = vi.fn();
  });
  afterEach(restoreTestEnvironment);

  it("rotates realtime bridges on provider max-duration events without reporting an error", async () => {
    vi.useFakeTimers();
    const bridge = createNativeBridge({ onError, onEvent, onReady });
    const firstSocket = await connectReadyBridge(bridge);
    expect(onReady).toHaveBeenCalledOnce();

    expireSession(firstSocket);

    expect(onError).not.toHaveBeenCalled();
    expect(firstSocket.closed).toBe(true);
    expectLifecycle("session.rotation", "reason=max-duration", "server");
    expectLifecycle("session.reconnect.scheduled", "reason=max-duration attempt=1 delayMs=1000");

    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const secondSocket = requireSocket(1);
    openSocket(secondSocket);
    emitSessionUpdated(secondSocket);

    await vi.waitFor(() =>
      expectLifecycle("session.rotation.ready", "reason=max-duration", "server"),
    );
    await vi.waitFor(() =>
      expectLifecycle("session.reconnect.ready", "reason=max-duration attempt=1"),
    );
    expect(bridge.isConnected()).toBe(true);
    expect(onReady).toHaveBeenCalledOnce();

    await bridge.close();
  });

  it("clears canceled rotation metadata before an explicit reconnect", async () => {
    vi.useFakeTimers();
    const bridge = createNativeBridge({ onClose, onError, onEvent, onReady });
    const { connecting, socket: firstSocket } = beginBridgeConnection(bridge);

    firstSocket.deferClose = true;
    openSocket(firstSocket);
    emitSessionUpdated(firstSocket);
    await connecting;
    expect(onReady).toHaveBeenCalledOnce();

    expireSession(firstSocket);
    expect(firstSocket.closed).toBe(true);

    void bridge.close();
    void bridge.close();
    expect(onClose).toHaveBeenCalledExactlyOnceWith("completed");

    const { connecting: reconnecting, socket: secondSocket } = beginBridgeConnection(bridge, 1);
    firstSocket.emitDeferredClose();
    openSocket(secondSocket);
    emitSessionUpdated(secondSocket);
    await reconnecting;

    expect(onReady).toHaveBeenCalledTimes(2);
    expect(onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "session.rotation.ready" }),
    );
    expect(onError).not.toHaveBeenCalled();

    dropSocket(secondSocket, "ordinary drop");
    await vi.advanceTimersByTimeAsync(0);

    expectLifecycle("session.reconnect.scheduled", "reason=websocket-close attempt=1 delayMs=1000");
    expect(onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session.reconnect.scheduled",
        detail: expect.stringContaining("reason=max-duration"),
      }),
    );

    void bridge.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenLastCalledWith("completed");
  });

  it("does not report reconnect readiness after cancellation during provider setup", async () => {
    vi.useFakeTimers();
    const bridge = createNativeBridge({ onClose, onError, onEvent });
    const socket = await connectReadyBridge(bridge);

    await openRetry(socket);

    void bridge.close();
    await vi.advanceTimersByTimeAsync(0);

    expect(onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "session.reconnect.ready" }),
    );
    expect(onError).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledExactlyOnceWith("completed");
  });

  it("lets cancellation win a queued reconnect startup error", async () => {
    vi.useFakeTimers();
    const bridge = createNativeBridge({ onClose, onError });
    const socket = await connectReadyBridge(bridge);

    const retrySocket = await openRetry(socket);
    emitServerEvent(retrySocket, {
      type: "error",
      error: { message: "queued retry startup failure" },
    });

    void bridge.close();
    await vi.advanceTimersByTimeAsync(0);

    expect(onError).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledExactlyOnceWith("completed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports one terminal error for malformed audio during reconnect setup", async () => {
    vi.useFakeTimers();
    const bridge = createNativeBridge({ onClose, onError, onEvent });
    const socket = await connectReadyBridge(bridge);

    const retrySocket = await openRetry(socket);
    emitServerEvent(retrySocket, {
      type: "response.output_audio.delta",
      item_id: "item_1",
      delta: "not-base64!",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(onError).toHaveBeenCalledExactlyOnceWith(
      new Error("OpenAI realtime stream returned malformed base64 audio data"),
    );
    expect(onClose).toHaveBeenCalledExactlyOnceWith("error");
    expect(onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "session.reconnect.ready" }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores late events from a socket replaced by reconnect", async () => {
    vi.useFakeTimers();
    const bridge = createNativeBridge({ onAudio, onClose, onError });
    const firstSocket = await connectReadyBridge(bridge);

    dropSocket(firstSocket);
    emitServerEvent(firstSocket, {
      type: "response.audio.delta",
      delta: Buffer.from("late audio").toString("base64"),
    });
    firstSocket.emit("error", new Error("late retry-wait failure"));
    expect(onAudio).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    const secondSocket = requireSocket(1);
    openSocket(secondSocket);
    emitSessionUpdated(secondSocket);
    await vi.waitFor(() => expect(bridge.isConnected()).toBe(true));

    emitSessionUpdated(firstSocket);
    firstSocket.emit("error", new Error("late socket failure"));
    firstSocket.emit("close", 1006, Buffer.from("late socket close"));
    await vi.advanceTimersByTimeAsync(0);

    expect(bridge.isConnected()).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
    expect(onError).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    await bridge.close();
  });

  it("exhausts retries when sockets open but never become provider-ready", async () => {
    vi.useFakeTimers();
    const bridge = createNativeBridge({ onClose, onError, onEvent });
    const firstSocket = await connectReadyBridge(bridge);
    dropSocket(firstSocket);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await vi.waitFor(() =>
        expectLifecycle(
          "session.reconnect.scheduled",
          `reason=websocket-close attempt=${attempt} delayMs=${1000 * 2 ** (attempt - 1)}`,
        ),
      );
      await vi.advanceTimersByTimeAsync(1000 * 2 ** (attempt - 1));
      const retrySocket = requireSocket(attempt);
      openSocket(retrySocket);
      emitServerEvent(retrySocket, {
        type: "error",
        error: { message: `retry startup failure ${attempt}` },
      });
    }

    await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith("error"));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledTimes(5);
    expect(FakeWebSocket.instances).toHaveLength(6);
    expectLifecycle("session.reconnect.exhausted", "reason=websocket-close attempts=5");

    void bridge.close();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps a retried connection ready after delayed startup failure close", async () => {
    const bridge = createNativeBridge({ onClose });
    const { connecting: failedConnect, socket: failedSocket } = beginBridgeConnection(bridge);
    failedSocket.deferClose = true;

    openSocket(failedSocket);
    emitServerEvent(failedSocket, {
      type: "error",
      error: { message: "Incorrect API key provided" },
    });

    await expect(failedConnect).rejects.toThrow(OPENAI_REALTIME_REJECTED_KEY_MESSAGE);
    expect(failedSocket.deferredClose).toBeDefined();

    await connectReadyBridge(bridge, 1);

    expect(bridge.isConnected()).toBe(true);
    failedSocket.emitDeferredClose();
    expect(bridge.isConnected()).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("resets consumer tool ownership before a fresh reconnect can reuse a call id", async () => {
    vi.useFakeTimers();
    const staleWork = new AbortController();
    const onContinuityEvent = vi.fn((event: RealtimeVoiceBridgeEvent) => {
      if (event.direction === "client" && event.type === "session.continuity.reset") {
        staleWork.abort();
      }
    });
    const onToolCall = vi.fn();
    const bridge = createNativeBridge({ onEvent: onContinuityEvent, onToolCall });
    const socket = await connectReadyBridge(bridge);
    emitCompletedToolCalls(socket, ["call_reused"]);
    expect(onToolCall).toHaveBeenCalledTimes(1);

    socket.emit("close", 1006, Buffer.from("transient drop"));
    const lifecycleEvents = onContinuityEvent.mock.calls.map(([event]) => event.type);
    expect(lifecycleEvents.indexOf("session.continuity.reset")).toBeLessThan(
      lifecycleEvents.indexOf("session.reconnect.scheduled"),
    );
    await vi.advanceTimersByTimeAsync(1000);
    const reconnectedSocket = requireSocket(1);
    openSocket(reconnectedSocket);
    emitSessionUpdated(reconnectedSocket);

    emitCompletedToolCalls(socket, ["call_from_old_socket"]);
    expect(
      parseSent(reconnectedSocket).filter((event) => event.type === "conversation.item.create"),
    ).toEqual([]);
    expect(onToolCall).toHaveBeenCalledTimes(1);

    emitCompletedToolCalls(reconnectedSocket, ["call_reused"]);
    if (!staleWork.signal.aborted) {
      void bridge.submitToolResult("call_reused", { text: "stale" });
    }
    const fresh = bridge.submitToolResult("call_reused", { text: "fresh" });
    emitFunctionOutputAdded(reconnectedSocket, "call_reused");
    await fresh;

    expect(onToolCall).toHaveBeenCalledTimes(2);
    expect(
      parseSent(reconnectedSocket)
        .filter(
          (event) =>
            event.type === "conversation.item.create" &&
            (event.item as { call_id?: string } | undefined)?.call_id === "call_reused",
        )
        .map((event) => (event.item as { output?: string } | undefined)?.output),
    ).toEqual([JSON.stringify({ text: "fresh" })]);
  });
});
