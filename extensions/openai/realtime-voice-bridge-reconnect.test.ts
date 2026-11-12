// Openai tests cover realtime voice provider plugin behavior.
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeEvent,
} from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const mocks = await vi.hoisted(async () => {
  const { createOpenAIRealtimeMockState } = await import("./realtime-voice-test-support.js");
  return createOpenAIRealtimeMockState();
});
const { FakeWebSocket } = mocks;

vi.mock("openclaw/plugin-sdk/websocket-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/websocket-runtime")>()),
  WebSocket: mocks.FakeWebSocket,
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
  emitAssistantPlayback,
  emitSessionUpdated,
  emitCompletedToolCalls,
  emitFunctionOutputAdded,
  connectReadyBridge,
  resetTestState,
  restoreTestEnvironment,
  rejectedKeyMessage: OPENAI_REALTIME_REJECTED_KEY_MESSAGE,
} = createOpenAIRealtimeTestSupport({ ...mocks, buildOpenAIRealtimeVoiceProvider });

function observedBridge(...keys: Array<"onClose" | "onError" | "onEvent" | "onReady" | undefined>) {
  const callbacks = { onClose: vi.fn(), onError: vi.fn(), onEvent: vi.fn(), onReady: vi.fn() };
  const selected: Partial<typeof callbacks> = {};
  for (const key of keys) {
    if (key) {
      selected[key] = callbacks[key];
    }
  }
  return { ...callbacks, bridge: createNativeBridge(selected) };
}
function dropSocket(socket: ReturnType<typeof requireSocket>) {
  socket.readyState = FakeWebSocket.CLOSED;
  socket.emit("close", 1006, Buffer.from("transient drop"));
}
function openRetrySocket() {
  const socket = requireSocket(1);
  openSocket(socket);
  return socket;
}
function providerError(socket: ReturnType<typeof requireSocket>, message: string) {
  emitServerEvent(socket, { type: "error", error: { message } });
}
function expectEvent(callback: unknown, type: string, detail: string, direction = "client") {
  expect(callback).toHaveBeenCalledWith({ direction, type, detail });
}
function expectNoEvent(callback: unknown, type: string) {
  expect(callback).not.toHaveBeenCalledWith(expect.objectContaining({ type }));
}

describe("OpenAI realtime voice bridge reconnect", () => {
  beforeEach(resetTestState);
  afterEach(restoreTestEnvironment);

  it("rotates realtime bridges on provider max-duration events without reporting an error", async () => {
    vi.useFakeTimers();
    const { bridge, onError, onEvent, onReady } = observedBridge("onError", "onEvent", "onReady");
    const firstSocket = await connectReadyBridge(bridge);
    expect(onReady).toHaveBeenCalledOnce();

    providerError(firstSocket, "Your session hit the maximum duration of 60 minutes.");

    expect(onError).not.toHaveBeenCalled();
    expect(firstSocket.closed).toBe(true);
    expectEvent(onEvent, "session.rotation", "reason=max-duration", "server");
    expectEvent(
      onEvent,
      "session.reconnect.scheduled",
      "reason=max-duration attempt=1 delayMs=1000",
    );

    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const secondSocket = requireSocket(1);
    openSocket(secondSocket);
    emitSessionUpdated(secondSocket);

    await vi.waitFor(() =>
      expectEvent(onEvent, "session.rotation.ready", "reason=max-duration", "server"),
    );
    await vi.waitFor(() =>
      expectEvent(onEvent, "session.reconnect.ready", "reason=max-duration attempt=1"),
    );
    expect(bridge.isConnected()).toBe(true);
    expect(onReady).toHaveBeenCalledOnce();

    await bridge.close();
  });

  it("clears canceled rotation metadata before an explicit reconnect", async () => {
    vi.useFakeTimers();
    const { bridge, onClose, onError, onEvent, onReady } = observedBridge(
      "onClose",
      "onError",
      "onEvent",
      "onReady",
    );
    const { connecting, socket: firstSocket } = beginBridgeConnection(bridge);

    firstSocket.deferClose = true;
    openSocket(firstSocket);
    emitSessionUpdated(firstSocket);
    await connecting;
    expect(onReady).toHaveBeenCalledOnce();

    providerError(firstSocket, "Your session hit the maximum duration of 60 minutes.");
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
    expectNoEvent(onEvent, "session.rotation.ready");
    expect(onError).not.toHaveBeenCalled();

    dropSocket(secondSocket);
    await vi.advanceTimersByTimeAsync(0);

    expectEvent(
      onEvent,
      "session.reconnect.scheduled",
      "reason=websocket-close attempt=1 delayMs=1000",
    );
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

  it.each(["pending setup", "queued startup error"])(
    "lets cancellation win during reconnect %s without reporting readiness",
    async (phase) => {
      vi.useFakeTimers();
      const { bridge, onClose, onError, onEvent } = observedBridge(
        "onClose",
        "onError",
        phase === "pending setup" ? "onEvent" : undefined,
      );
      const socket = await connectReadyBridge(bridge);

      dropSocket(socket);
      await vi.advanceTimersByTimeAsync(1000);
      const retry = openRetrySocket();
      if (phase === "queued startup error") {
        providerError(retry, "queued retry startup failure");
      }

      void bridge.close();
      await vi.advanceTimersByTimeAsync(0);

      if (phase === "pending setup") {
        expectNoEvent(onEvent, "session.reconnect.ready");
      }
      expect(onError).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalledExactlyOnceWith("completed");
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("reports one terminal error for malformed audio during reconnect setup", async () => {
    vi.useFakeTimers();
    const { bridge, onClose, onError, onEvent } = observedBridge("onClose", "onError", "onEvent");
    const socket = await connectReadyBridge(bridge);

    dropSocket(socket);
    await vi.advanceTimersByTimeAsync(1000);
    emitServerEvent(openRetrySocket(), {
      type: "response.output_audio.delta",
      item_id: "item_1",
      delta: "not-base64!",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(onError).toHaveBeenCalledExactlyOnceWith(
      new Error("OpenAI realtime stream returned malformed base64 audio data"),
    );
    expect(onClose).toHaveBeenCalledExactlyOnceWith("error");
    expectNoEvent(onEvent, "session.reconnect.ready");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores late events from a socket replaced by reconnect", async () => {
    vi.useFakeTimers();
    const onAudio = vi.fn();
    const onClose = vi.fn();
    const onError = vi.fn();
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
    const secondSocket = openRetrySocket();
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
    const { bridge, onClose, onError, onEvent } = observedBridge("onClose", "onError", "onEvent");
    const firstSocket = await connectReadyBridge(bridge);

    dropSocket(firstSocket);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await vi.waitFor(() =>
        expectEvent(
          onEvent,
          "session.reconnect.scheduled",
          `reason=websocket-close attempt=${attempt} delayMs=${1000 * 2 ** (attempt - 1)}`,
        ),
      );
      await vi.advanceTimersByTimeAsync(1000 * 2 ** (attempt - 1));
      const retrySocket = requireSocket(attempt);
      openSocket(retrySocket);
      providerError(retrySocket, `retry startup failure ${attempt}`);
    }

    await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith("error"));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledTimes(5);
    expect(FakeWebSocket.instances).toHaveLength(6);
    expectEvent(onEvent, "session.reconnect.exhausted", "reason=websocket-close attempts=5");

    void bridge.close();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps a retried connection ready after delayed startup failure close", async () => {
    const onClose = vi.fn();
    const bridge = createNativeBridge({ onClose });
    const { connecting: failedConnect, socket: failedSocket } = beginBridgeConnection(bridge);
    failedSocket.deferClose = true;

    openSocket(failedSocket);
    providerError(failedSocket, "Incorrect API key provided");

    await expect(failedConnect).rejects.toThrow(OPENAI_REALTIME_REJECTED_KEY_MESSAGE);
    expect(failedSocket.deferredClose).toBeDefined();

    const { connecting: retryConnect, socket: retrySocket } = beginBridgeConnection(bridge, 1);
    openSocket(retrySocket);
    emitSessionUpdated(retrySocket);
    await retryConnect;

    expect(bridge.isConnected()).toBe(true);
    failedSocket.emitDeferredClose();
    expect(bridge.isConnected()).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("resets consumer tool ownership before a fresh reconnect can reuse a call id", async () => {
    vi.useFakeTimers();
    const staleWork = new AbortController();
    const onEvent = vi.fn((event: RealtimeVoiceBridgeEvent) => {
      if (event.direction === "client" && event.type === "session.continuity.reset") {
        staleWork.abort();
      }
    });
    const onToolCall = vi.fn();
    const bridge = createNativeBridge({ onEvent, onToolCall });
    const socket = await connectReadyBridge(bridge);
    emitCompletedToolCalls(socket, ["call_reused"]);
    expect(onToolCall).toHaveBeenCalledTimes(1);

    socket.emit("close", 1006, Buffer.from("transient drop"));
    const lifecycleEvents = onEvent.mock.calls.map(([event]) => event.type);
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

type Socket = ReturnType<typeof requireSocket>;
const responses = (socket: Socket, type = "response.create") =>
  parseSent(socket).filter((event) => event.type === type);
function playResponse(socket: Socket, responseId: string, itemId: string) {
  emitAssistantPlayback(socket, { responseId, itemId, audio: Buffer.alloc(320) });
}
function finishResponse(socket: Socket, id: string, status = "completed") {
  emitServerEvent(socket, { type: "response.done", response: { id, status, output: [] } });
}
async function interruptibleBridge(
  eventType: "session.update" | "response.create",
  options: Parameters<typeof createNativeBridge>[0] = {},
  onClearAudio?: (bridge: RealtimeVoiceBridge) => void,
) {
  let armed = false;
  const bridge = createNativeBridge({
    ...options,
    onClearAudio: () => onClearAudio?.(bridge),
    onEvent: (event) => {
      if (armed && event.direction === "client" && event.type === eventType) {
        armed = false;
        bridge.handleBargeIn?.({ force: true });
      }
    },
  });
  const socket = await connectReadyBridge(bridge);
  armed = true;
  return { bridge, socket };
}

describe("OpenAI realtime outgoing response ownership", () => {
  beforeEach(resetTestState);
  afterEach(restoreTestEnvironment);

  it.each(["manual", "standalone"])(
    "sends %s creation before its observer can cancel",
    async (mode) => {
      const onPlaybackAudio = vi.fn();
      const { bridge, socket } = await interruptibleBridge("response.create", {
        autoRespondToAudio: false,
        onAudio: onPlaybackAudio,
        onToolCall: vi.fn(),
      });
      if (mode === "standalone") {
        emitCompletedToolCalls(socket);
      }
      bridge.sendUserMessage?.("First response.");
      expect(
        parseSent(socket)
          .filter((event) => event.type.startsWith("response."))
          .map((event) => event.type),
      ).toEqual(["response.create", "response.cancel"]);
      playResponse(socket, "cancelled", "discarded");
      expect(onPlaybackAudio).not.toHaveBeenCalled();
      bridge.sendUserMessage?.("Follow-up response.");
      expect(responses(socket)).toHaveLength(1);
      finishResponse(socket, "cancelled", "cancelled");
      expect(responses(socket)).toHaveLength(2);
      playResponse(socket, "recovery", "heard");
      expect(onPlaybackAudio).toHaveBeenCalledTimes(1);
      await bridge.close();
    },
  );

  it.each([false, true])(
    "cancels during VAD suppression and preserves replacement admission (clear requests replacement=%s)",
    async (replaceOnClear) => {
      const { bridge, socket } = await interruptibleBridge("session.update", {}, (activeBridge) => {
        if (replaceOnClear) {
          activeBridge.sendUserMessage?.("Replacement from the clear callback.");
        }
      });
      bridge.sendUserMessage?.("Cancelled before response creation.");
      expect(responses(socket, "response.cancel")).toEqual([]);
      expect(responses(socket)).toHaveLength(replaceOnClear ? 1 : 0);
      if (replaceOnClear) {
        bridge.sendUserMessage?.("Queued behind the replacement.");
        expect(responses(socket)).toHaveLength(1);
        finishResponse(socket, "replacement");
        expect(responses(socket)).toHaveLength(2);
      } else {
        expect(
          parseSent(socket).at(-1)?.session?.audio?.input?.turn_detection?.create_response,
        ).toBe(true);
        bridge.sendUserMessage?.("Follow-up without a native terminal for the unsent response.");
        expect(responses(socket)).toHaveLength(1);
      }
      await bridge.close();
    },
  );
  it("finishes history truncation and sink clearing before a truncate observer's replacement response", async () => {
    const trace: string[] = [];
    const bridge = createNativeBridge({
      autoRespondToAudio: false,
      getPlaybackState: () => [{ itemId: "completed-a", audioEndMs: 500 }],
      onClearAudio: () => trace.push("sink.clear"),
      onEvent: (event) => {
        if (event.direction === "client" && event.type === "conversation.item.truncate") {
          bridge.sendUserMessage?.("Replacement B.");
        }
      },
    });
    const socket = await connectReadyBridge(bridge);
    emitServerEvent(socket, { type: "response.created", response: { id: "a" } });
    finishResponse(socket, "a");
    vi.spyOn(socket, "send").mockImplementation((payload: string) => {
      socket.sent.push(payload);
      const event = JSON.parse(payload) as { type: string };
      if (event.type !== "conversation.item.create") {
        trace.push(event.type);
      }
    });
    bridge.handleBargeIn?.({ force: true });
    expect(trace).toEqual(["conversation.item.truncate", "sink.clear", "response.create"]);
    await bridge.close();
  });
  it("does not drain a replacement when preparing-response cleanup throws", async () => {
    const { bridge, socket } = await interruptibleBridge("session.update", {}, (activeBridge) => {
      activeBridge.sendUserMessage?.("Queued replacement.");
      throw new Error("sink clear failed");
    });
    expect(() => bridge.sendUserMessage?.("Cancelled preparation.")).toThrow("sink clear failed");
    expect(parseSent(socket).filter((event) => event.type.startsWith("response."))).toEqual([]);
    bridge.sendUserMessage?.("Explicit follow-up after the failed clear.");
    expect(responses(socket)).toHaveLength(1);
    await bridge.close();
  });
});
