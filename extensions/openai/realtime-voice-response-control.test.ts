import type {
  RealtimeVoiceBridge,
  RealtimeVoiceResponseOutcome,
} from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const mocks = await vi.hoisted(async () => {
  const { createOpenAIRealtimeMockState } = await import("./realtime-voice-test-support.js");
  return createOpenAIRealtimeMockState();
});
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

// mock-isolation: Response-control tests own the transport credential fixture and exclude host auth storage.
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
  connectReadyBridge,
  expectedResponseCreateEvent,
  requireNestedRecord,
  resetTestState,
  restoreTestEnvironment,
} = createOpenAIRealtimeTestSupport({ ...mocks, buildOpenAIRealtimeVoiceProvider });

describe("OpenAI realtime voice response control", () => {
  beforeEach(resetTestState);
  afterEach(restoreTestEnvironment);

  type Socket = ReturnType<typeof requireSocket>;
  const sentOfType = (socket: Socket, type: string) =>
    parseSent(socket).filter((event) => event.type === type);
  async function ready(overrides: Parameters<typeof createNativeBridge>[0] = {}) {
    const bridge = createNativeBridge(overrides);
    return { bridge, socket: await connectReadyBridge(bridge) };
  }
  function emitError(socket: Socket, message: string, event_id: string) {
    emitServerEvent(socket, { type: "error", error: { event_id, message } });
  }
  function eventId(socket: Socket, type: string) {
    const id = sentOfType(socket, type).at(-1)?.event_id;
    if (!id) {
      throw new Error(`expected ${type} event id`);
    }
    return id;
  }
  function expectTurnDetection(socket: Socket, createResponse = true, index = -1) {
    expect(
      requireNestedRecord(parseSent(socket).at(index)?.session, [
        "audio",
        "input",
        "turn_detection",
      ]),
    ).toMatchObject({
      create_response: createResponse,
      interrupt_response: true,
    });
  }

  it("suppresses auto responses before draining queued initial greeting audio", async () => {
    const onReady = vi.fn(() => {
      bridge.triggerGreeting?.("Say exactly: hello from explicit speech.");
    });
    const bridge: RealtimeVoiceBridge = createNativeBridge({
      instructions: "Be helpful.",
      onReady,
    });
    const { connecting, socket } = beginBridgeConnection(bridge);
    openSocket(socket);
    await Promise.resolve();
    bridge.sendAudio(Buffer.from("before-ready"));
    emitSessionUpdated(socket);
    await connecting;
    const sent = parseSent(socket);
    expect(sent).toEqual([
      expect.objectContaining({ type: "session.update" }),
      expect.objectContaining({ type: "conversation.item.create" }),
      {
        type: "session.update",
        session: {
          type: "realtime",
          audio: {
            input: {
              turn_detection: {
                type: "server_vad",
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 500,
                create_response: false,
                interrupt_response: true,
              },
            },
          },
        },
      },
      expect.objectContaining({ type: "response.create" }),
      {
        type: "input_audio_buffer.append",
        audio: Buffer.from("before-ready").toString("base64"),
      },
    ]);
    expect(onReady).toHaveBeenCalledTimes(1);
    emitServerEvent(socket, { type: "response.done" });

    expectTurnDetection(socket);
  });

  it("forces one host-selected function on an otherwise automatic response", async () => {
    const { bridge, socket } = await ready();
    bridge.sendUserMessage?.("Run the deterministic check.", {
      toolChoice: { type: "function", name: "lookup_weather" },
    });
    expect(parseSent(socket).at(-1)).toEqual({
      type: "response.create",
      event_id: expect.stringMatching(/^openclaw-response-create-/),
      response: {
        output_modalities: ["audio"],
        tool_choice: { type: "function", name: "lookup_weather" },
      },
    });
  });

  it.each([
    { mode: "manual", hasEventId: false },
    { mode: "standalone", hasEventId: false },
  ] as const)(
    "settles rejected $mode speech (eventId=$hasEventId) before dispatching the consumer's next message",
    async ({ mode }) => {
      const onError = vi.fn();
      const onResponseDone = vi.fn((outcome: RealtimeVoiceResponseOutcome) => {
        if (outcome.status === "failed") {
          bridge.sendUserMessage?.("Say exactly: the next answer.");
        }
      });
      const { bridge, socket } = await ready({ onError, onResponseDone, onToolCall: vi.fn() });
      if (mode === "standalone") {
        emitCompletedToolCalls(socket);
        onResponseDone.mockClear();
      }
      bridge.sendUserMessage?.("Say exactly: the first answer.");
      const rejected = eventId(socket, "response.create");
      const rejection = {
        type: "error",
        error: {
          type: "invalid_request_error",
          code: "invalid_value",
          param: "response.tool_choice",
          message: "Speech request rejected",
        },
      };

      emitServerEvent(socket, rejection);

      expect(onResponseDone).toHaveBeenCalledExactlyOnceWith({
        status: "failed",
        error: {
          type: "invalid_request_error",
          code: "invalid_value",
          message: "Speech request rejected",
        },
        message: "OpenAI realtime voice response failed: Speech request rejected",
      });
      expect(onError).toHaveBeenCalledExactlyOnceWith(new Error("Speech request rejected"));
      const responseCreates = sentOfType(socket, "response.create");
      expect(responseCreates).toHaveLength(2);
      expect(responseCreates[1]?.event_id).not.toBe(rejected);
      expect(bridge.isConnected()).toBe(true);

      emitServerEvent(socket, {
        ...rejection,
        error: { ...rejection.error, event_id: rejected },
      });
      expect(onResponseDone).toHaveBeenCalledOnce();
      expect(sentOfType(socket, "response.create")).toHaveLength(2);
      emitServerEvent(socket, { type: "response.created", response: { id: "response-next" } });
      emitServerEvent(socket, {
        type: "error",
        error: {
          type: "invalid_request_error",
          param: "response.tool_choice",
          message: "Late error",
        },
      });
      expect(onResponseDone).toHaveBeenCalledOnce();
      await bridge.close();
    },
  );

  it("keeps automatic audio suppressed for unrelated errors during a manual response", async () => {
    const onError = vi.fn();
    const onResponseDone = vi.fn();
    const { bridge, socket } = await ready({ onError, onResponseDone });
    bridge.triggerGreeting?.("Say exactly: hello from explicit speech.");
    const sessionUpdatesBeforeError = sentOfType(socket, "session.update");
    emitServerEvent(socket, {
      type: "error",
      error: {
        event_id: "unrelated-audio-event",
        type: "invalid_request_error",
        param: "response.tool_choice",
        message: "bad audio append",
      },
    });
    expect(onError).toHaveBeenCalledWith(new Error("bad audio append"));
    expect(onResponseDone).not.toHaveBeenCalled();
    expect(sentOfType(socket, "session.update")).toHaveLength(sessionUpdatesBeforeError.length);
    emitServerEvent(socket, { type: "response.done" });

    expectTurnDetection(socket);
  });

  it("flushes a queued manual response after the prior request is rejected", async () => {
    const onError = vi.fn();
    const { bridge, socket } = await ready({ onError });
    bridge.triggerGreeting?.("Say exactly: first greeting.");
    const firstResponseCreate = eventId(socket, "response.create");
    const sessionUpdateCount = sentOfType(socket, "session.update").length;
    bridge.sendUserMessage?.("Say exactly: queued follow-up.");
    emitError(socket, "bad response request", firstResponseCreate);
    const responseCreates = sentOfType(socket, "response.create");
    expect(responseCreates).toHaveLength(2);
    expect(responseCreates[1]).toEqual(expectedResponseCreateEvent());
    expect(responseCreates[1]?.event_id).not.toBe(firstResponseCreate);
    expect(sentOfType(socket, "session.update")).toHaveLength(sessionUpdateCount);
    expect(onError).toHaveBeenCalledWith(new Error("bad response request"));
    emitServerEvent(socket, { type: "response.done" });

    expectTurnDetection(socket);
  });

  it("serializes standalone control speech while an agent tool call is pending", async () => {
    const { bridge, socket } = await ready({ onToolCall: vi.fn() });
    emitCompletedToolCalls(socket);

    for (const text of ["status", "steer", "cancel"]) {
      bridge.sendUserMessage?.(text);
    }
    expect(sentOfType(socket, "response.create")).toHaveLength(1);

    for (let index = 0; index < 3; index += 1) {
      emitServerEvent(socket, {
        type: "response.created",
        response: { id: `resp_control_${index}` },
      });
      emitServerEvent(socket, {
        type: "response.done",
        response: { id: `resp_control_${index}`, status: "completed", output: [] },
      });
      expect(sentOfType(socket, "response.create")).toHaveLength(Math.min(index + 2, 3));
    }
  });

  it.each(["response.cancelled", "no-active-response error"])(
    "drains deferred response.create after %s",
    async (terminal) => {
      const onError = vi.fn();
      const { bridge, socket } = await ready({ onError });
      emitServerEvent(socket, { type: "response.created", response: { id: "resp_1" } });
      bridge.sendUserMessage?.("queued after cancellation");
      if (terminal === "response.cancelled") {
        emitServerEvent(socket, { type: terminal });
      } else {
        bridge.handleBargeIn?.({ audioPlaybackActive: true });
        emitError(
          socket,
          "Cancellation failed: no active response found",
          eventId(socket, "response.cancel"),
        );
        expect(onError).not.toHaveBeenCalled();
      }
      expect(parseSent(socket).slice(-1)).toEqual([expectedResponseCreateEvent()]);
    },
  );

  it("ignores a stale cancellation error after a newer manual response starts", async () => {
    const onError = vi.fn();
    const { bridge, socket } = await ready({ onError });
    bridge.setMediaTimestamp(1000);
    emitAssistantPlayback(socket, { audio: Buffer.alloc(2_400) });
    bridge.setMediaTimestamp(1300);
    bridge.handleBargeIn?.({ audioPlaybackActive: true });
    const responseCancelEvent = eventId(socket, "response.cancel");
    bridge.sendUserMessage?.("queued newer response");
    emitServerEvent(socket, { type: "response.done" });
    const sessionUpdateCount = sentOfType(socket, "session.update").length;
    emitError(socket, "Cancellation failed: no active response found", responseCancelEvent);
    expect(onError).not.toHaveBeenCalled();
    expect(sentOfType(socket, "session.update")).toHaveLength(sessionUpdateCount);
    expect(parseSent(socket).at(-1)).toEqual(expectedResponseCreateEvent());
    emitServerEvent(socket, { type: "response.done" });
    expectTurnDetection(socket);
  });

  it("resets deferred response guards after websocket reconnect", async () => {
    vi.useFakeTimers();
    const { bridge, socket } = await ready();
    emitServerEvent(socket, { type: "response.created", response: { id: "resp_1" } });
    bridge.sendUserMessage?.("queued before reconnect");
    expect(parseSent(socket).slice(-1)[0]?.type).toBe("conversation.item.create");
    socket.emit("close", 1006, Buffer.from("transient drop"));
    await vi.advanceTimersByTimeAsync(1000);
    const reconnectedSocket = requireSocket(1);
    openSocket(reconnectedSocket);
    emitSessionUpdated(reconnectedSocket);
    bridge.sendUserMessage?.("Say hello after reconnect.");
    expect(parseSent(reconnectedSocket).slice(-3)).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Say hello after reconnect." }],
        },
      },
      expect.objectContaining({ type: "session.update" }),
      expectedResponseCreateEvent(),
    ]);
  });

  it("turns active-response errors into a deferred response.create retry", async () => {
    const onError = vi.fn();
    const onResponseDone = vi.fn();
    const { bridge, socket } = await ready({ onError, onResponseDone });
    bridge.sendUserMessage?.("trigger active-response retry");
    const responseCreateEvent = eventId(socket, "response.create");
    emitError(
      socket,
      "Conversation already has an active response in progress: resp_1",
      responseCreateEvent,
    );
    const afterError = parseSent(socket);
    expect(onResponseDone).not.toHaveBeenCalled();
    expect(afterError.filter((event) => event.type === "session.update")).toHaveLength(2);
    expectTurnDetection(socket, false, -2);
    emitServerEvent(socket, { type: "response.done" });
    expect(onError).not.toHaveBeenCalled();
    expect(parseSent(socket).slice(-1)).toEqual([expectedResponseCreateEvent()]);
    emitServerEvent(socket, { type: "response.done" });

    expectTurnDetection(socket);
  });
});
