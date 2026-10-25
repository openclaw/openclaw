import {
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  type RealtimeVoiceBridgeEvent,
} from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const mocks = await vi.hoisted(async () => {
  const { createOpenAIRealtimeMockState } = await import("./realtime-voice-test-support.js");
  return createOpenAIRealtimeMockState();
});
vi.mock("openclaw/plugin-sdk/websocket-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/websocket-runtime")>()),
  WebSocket: mocks.FakeWebSocket,
}));

// mock-isolation: Playback event tests use synthetic credentials; host auth storage is outside this transport fixture.
vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  isProviderAuthProfileConfigured: mocks.isProviderAuthProfileConfiguredMock,
  isProviderAuthProfileConfiguredAsync: mocks.isProviderAuthProfileConfiguredMock,
  resolveProviderAuthProfileApiKey: mocks.resolveProviderAuthProfileApiKeyMock,
}));
import { createOpenAIRealtimeTestSupport } from "./realtime-voice-test-support.js";

const {
  parseSent,
  createNativeBridge,
  connectReadyBridge,
  emitServerEvent,
  emitAssistantPlayback,
  emitCompletedToolCalls,
  expectedFunctionOutput,
  expectedResponseCreateEvent,
  expectedResponseCancelEvent,
  hasSentEventType,
  resetTestState,
  restoreTestEnvironment,
} = createOpenAIRealtimeTestSupport({ ...mocks, buildOpenAIRealtimeVoiceProvider });

type Socket = Awaited<ReturnType<typeof connectReadyBridge>>;
const sentOfType = (socket: Socket, type: string) =>
  parseSent(socket).filter((event) => event.type === type);
const truncations = (socket: Socket) => sentOfType(socket, "conversation.item.truncate");
const truncation = (item_id: string, audio_end_ms: number) => ({
  type: "conversation.item.truncate",
  item_id,
  content_index: 0,
  audio_end_ms,
});
function expectTruncations(socket: Socket, ...items: [string, number][]) {
  expect(truncations(socket)).toEqual(items.map(([id, ms]) => truncation(id, ms)));
}
const audioDelta = (item_id: string, bytes = 8_000, response_id?: string) => ({
  type: "response.output_audio.delta",
  item_id,
  response_id,
  delta: Buffer.alloc(bytes).toString("base64"),
});
const created = (socket: Socket, id: string) =>
  emitServerEvent(socket, { type: "response.created", response: { id } });
const completedPlayback = (socket: Socket, id: string) =>
  emitServerEvent(socket, { type: "response.done", response: { id, status: "completed" } });
const expectedToolContinuation = (callId: string, result: unknown) => [
  expectedFunctionOutput(callId, result),
  expect.objectContaining({ type: "session.update" }),
  expectedResponseCreateEvent(),
];
function emitPlaybackBurst(socket: Socket) {
  const event = {
    type: "response.audio.delta",
    item_id: "item_1",
    delta: Buffer.from("assistant audio").toString("base64"),
  };
  for (let index = 0; index < 300; index += 1) {
    emitServerEvent(socket, event);
  }
}
async function connectBridge<T extends NonNullable<Parameters<typeof createNativeBridge>[0]>>(
  overrides: T,
) {
  const bridge = createNativeBridge(overrides);
  return { ...overrides, bridge, socket: await connectReadyBridge(bridge) };
}
function playbackSink(...items: [string, number][]) {
  let playback = items.map(([itemId, audioEndMs]) => ({ itemId, audioEndMs }));
  return {
    getPlaybackState: () => playback,
    onClearAudio: vi.fn(() => {
      playback = [];
    }),
  };
}

describe("OpenAI realtime voice bridge events", () => {
  it("acknowledges A playback after B starts without PCM", async () => {
    const { bridge, socket, onMark } = await connectBridge({ onMark: vi.fn() });
    bridge.setMediaTimestamp(1000);
    emitAssistantPlayback(socket, {
      responseId: "response-a",
      itemId: "audio-a",
      audio: Buffer.alloc(8000),
    });
    completedPlayback(socket, "response-a");
    const acknowledgeA = onMark.mock.calls[0]?.[1];
    expect(acknowledgeA).toBeTypeOf("function");
    created(socket, "response-b");
    acknowledgeA();
    acknowledgeA();
    bridge.setMediaTimestamp(1500);
    bridge.handleBargeIn?.();
    expect(sentOfType(socket, "conversation.item.truncate")).toEqual([]);
    await bridge.close();
  });

  it("does not acknowledge replacement playback through a retained old connection callback", async () => {
    const { bridge, socket: firstSocket, onMark } = await connectBridge({ onMark: vi.fn() });
    emitAssistantPlayback(firstSocket, { itemId: "old-audio", audio: Buffer.alloc(8000) });
    const oldAck = onMark.mock.calls[0]?.[1];
    expect(oldAck).toBeTypeOf("function");
    await bridge.close();
    const secondSocket = await connectReadyBridge(bridge, 1);
    bridge.setMediaTimestamp(1000);
    emitAssistantPlayback(secondSocket, { itemId: "replacement-audio", audio: Buffer.alloc(8000) });
    const currentAck = onMark.mock.calls[1]?.[1];
    expect(currentAck).toBeTypeOf("function");
    oldAck();
    oldAck();
    bridge.setMediaTimestamp(1500);
    bridge.handleBargeIn?.();
    expectTruncations(secondSocket, ["replacement-audio", 500]);
    currentAck(); // The cleared mark is harmless too.
    await bridge.close();
  });

  beforeEach(resetTestState);
  afterEach(restoreTestEnvironment);

  it("keeps the echo guard relative to playback across a short prefix (50 ms of continuation)", async () => {
    const continuationMs = 50;
    const sink = playbackSink(["prefix", 200], ["continuation", continuationMs]);
    const { bridge, socket } = await connectBridge(sink);
    created(socket, "one-response");
    for (const [itemId, bytes] of [
      ["prefix", 1_600],
      ["continuation", 8_000],
    ] as const) {
      emitServerEvent(socket, audioDelta(itemId, bytes, "one-response"));
    }
    bridge.handleBargeIn?.({ audioPlaybackActive: true });
    expect(sink.onClearAudio).toHaveBeenCalledTimes(1);
    expect(sentOfType(socket, "response.cancel")).toHaveLength(1);
    expectTruncations(socket, ["prefix", 200], ["continuation", continuationMs]);
    await bridge.close();
  });

  it("cancels a requested response without truncating a fully heard item", async () => {
    const { bridge, socket, onAudio } = await connectBridge({
      getPlaybackState: () => [],
      onAudio: vi.fn(),
    });
    emitAssistantPlayback(socket);
    emitServerEvent(socket, { type: "response.done", response: { status: "completed" } });
    bridge.sendUserMessage?.("Next answer");
    bridge.handleBargeIn?.({ audioPlaybackActive: true, force: true });
    bridge.handleBargeIn?.({ audioPlaybackActive: true, force: true });
    created(socket, "next");
    emitServerEvent(socket, audioDelta("next"));
    expect(onAudio).toHaveBeenCalledOnce();
    expect(sentOfType(socket, "response.cancel")).toHaveLength(1);
    expect(sentOfType(socket, "conversation.item.truncate")).toEqual([]);
    await bridge.close();
  });

  it.each(["response.created", "response.output_audio.delta"])(
    "allows the %s observer to cancel before PCM delivery",
    async (interruptOn) => {
      const { bridge, socket, onAudio } = await connectBridge({
        onAudio: vi.fn(),
        getPlaybackState: () => [],
        onEvent: (event: RealtimeVoiceBridgeEvent) => {
          if (event.direction === "server" && event.type === interruptOn) {
            bridge.handleBargeIn?.({ force: true });
          }
        },
      });
      created(socket, "native");
      emitServerEvent(socket, audioDelta("native"));
      expect(onAudio).not.toHaveBeenCalled();
      expect(sentOfType(socket, "response.cancel")).toHaveLength(1);
      await bridge.close();
    },
  );

  it("sends no later frames when the cancellation observer closes the bridge", async () => {
    const { bridge, socket } = await connectBridge({
      getPlaybackState: () => [{ itemId: "interrupted", audioEndMs: 500 }],
      onEvent: (event) => {
        if (event.direction === "client" && event.type === "response.cancel") {
          void bridge.close();
        }
      },
    });
    created(socket, "native");
    const sent = socket.sent.length;
    expect(() => bridge.handleBargeIn?.({ force: true })).not.toThrow();
    expect(socket.closed).toBe(true);
    expect(socket.sent).toHaveLength(sent + 1);
    expect(parseSent(socket).at(-1)?.type).toBe("response.cancel");
  });

  it("interrupts each playback item once when the response.cancel observer repeats control", async () => {
    const sink = playbackSink(["audible", 620], ["queued", 0]);
    let repeated = false;
    const { bridge, socket, onAudio } = await connectBridge({
      ...sink,
      onAudio: vi.fn(),
      onEvent: (event) => {
        if (event.direction === "client" && event.type === "response.cancel" && !repeated) {
          repeated = true;
          bridge.handleBargeIn?.({ force: true });
        }
      },
    });
    for (const itemId of ["audible", "queued"]) {
      created(socket, itemId);
      emitServerEvent(socket, audioDelta(itemId, 8_000, itemId));
      completedPlayback(socket, itemId);
    }
    created(socket, "next");
    emitServerEvent(socket, { type: "input_audio_buffer.speech_started" });
    expect(sentOfType(socket, "response.cancel")).toHaveLength(1);
    expectTruncations(socket, ["audible", 620], ["queued", 0]);
    expect(onAudio).toHaveBeenLastCalledWith(Buffer.alloc(8_000), { itemId: "queued" });
    expect(sink.onClearAudio).toHaveBeenCalledOnce();
    await bridge.close();
  });

  it.each(["cancel", "close"])(
    "does not publish marks or late PCM after an audio callback requests %s",
    async (action) => {
      const onMark = vi.fn();
      const onAudio = vi.fn(() => {
        if (action === "close") {
          void bridge.close();
        } else {
          bridge.handleBargeIn?.({ audioPlaybackActive: true, force: true });
        }
      });
      const { bridge, socket } = await connectBridge({
        onAudio,
        onMark,
        ...playbackSink(["current", 0]),
      });
      created(socket, "current");
      const audio = audioDelta("current");
      emitServerEvent(socket, audio);
      emitServerEvent(socket, audio);
      expect(onAudio).toHaveBeenCalledOnce();
      expect(onMark).not.toHaveBeenCalled();
      await bridge.close();
    },
  );

  it.each([
    { format: undefined, bytesPerMs: 8, producedAudioMs: 300, elapsed: 300 },
    {
      format: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      bytesPerMs: 48,
      producedAudioMs: 3700,
      elapsed: 3760,
    },
  ])(
    "clamps interrupted $bytesPerMs-byte/ms playback to produced duration",
    async ({ format, bytesPerMs, producedAudioMs, elapsed }) => {
      const onAudio = vi.fn();
      const onClearAudio = vi.fn();
      const { bridge, socket } = await connectBridge({
        onAudio,
        onClearAudio,
        audioFormat: format,
        onMark: () => bridge.acknowledgeMark(),
      });

      bridge.setMediaTimestamp(1000);
      emitAssistantPlayback(socket, { audio: Buffer.alloc(producedAudioMs * bytesPerMs) });
      bridge.setMediaTimestamp(1000 + elapsed);

      bridge.handleBargeIn?.({ audioPlaybackActive: true });

      expect(onAudio).toHaveBeenCalledTimes(1);
      expect(onClearAudio).toHaveBeenCalledWith("barge-in");
      expect(truncations(socket).at(-1)).toEqual(truncation("item_1", producedAudioMs));
      expect(parseSent(socket).some((event) => event.type === "response.cancel")).toBe(true);
    },
  );

  it("preserves FIFO playback acknowledgements after sustained output", async () => {
    const { bridge, socket, onClearAudio, onMark } = await connectBridge({
      onClearAudio: vi.fn(),
      onMark: vi.fn(),
    });

    bridge.setMediaTimestamp(1000);
    emitPlaybackBurst(socket);

    expect(onMark.mock.calls).toHaveLength(300);
    for (let index = 0; index < 299; index += 1) {
      bridge.acknowledgeMark();
    }
    bridge.setMediaTimestamp(1300);
    bridge.handleBargeIn?.();

    expect(parseSent(socket).slice(-1)).toEqual([truncation("item_1", 300)]);
    expect(onClearAudio).toHaveBeenCalledWith("barge-in");

    emitServerEvent(socket, { type: "response.done", response: { status: "cancelled" } });
    emitServerEvent(socket, { type: "response.created" });
    emitPlaybackBurst(socket);
    const latestMark = onMark.mock.calls.at(-1)?.[0];
    if (typeof latestMark !== "string") {
      throw new Error("expected a playback mark");
    }
    bridge.acknowledgeMark(latestMark);
    bridge.setMediaTimestamp(1600);
    bridge.handleBargeIn?.();

    expect(sentOfType(socket, "conversation.item.truncate")).toHaveLength(1);
    await bridge.close();
  });

  it("surfaces input transcription failures with their provider error details", async () => {
    const { socket, onError, onEvent } = await connectBridge({
      onError: vi.fn(),
      onEvent: vi.fn(),
    });

    emitServerEvent(socket, {
      type: "conversation.item.input_audio_transcription.failed",
      item_id: "item_speech",
      error: { code: "decoder_failure", message: "speech decoder exploded" },
    });

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "speech decoder exploded" }),
    );
    expect(onEvent).toHaveBeenCalledWith({
      direction: "server",
      type: "conversation.item.input_audio_transcription.failed",
      itemId: "item_speech",
      detail: "speech decoder exploded",
    });
  });

  it("preserves corrected final text from legacy realtime text events", async () => {
    const { socket, onTranscript } = await connectBridge({ onTranscript: vi.fn() });

    emitServerEvent(socket, { type: "response.text.delta", delta: "draft assistant" });
    emitServerEvent(socket, { type: "response.text.done", text: "corrected assistant" });

    expect(onTranscript.mock.calls).toEqual([
      ["assistant", "draft assistant", false],
      ["assistant", "corrected assistant", true],
    ]);
  });

  it("forwards Codex-compatible legacy realtime audio and transcript events", async () => {
    const { socket, onAudio, onTranscript } = await connectBridge({
      onAudio: vi.fn(),
      onTranscript: vi.fn(),
    });

    const audio = Buffer.from("legacy assistant audio");
    emitServerEvent(socket, {
      type: "conversation.output_audio.delta",
      data: audio.toString("base64"),
      sample_rate: 24000,
      channels: 1,
    });
    emitServerEvent(socket, { type: "conversation.input_transcript.delta", delta: "partial user" });
    emitServerEvent(socket, {
      type: "conversation.output_transcript.delta",
      delta: "partial assistant",
    });
    emitServerEvent(socket, { type: "response.output_text.done", text: "final assistant text" });

    expect(onAudio).toHaveBeenCalledWith(audio, undefined);
    expect(onTranscript).toHaveBeenCalledWith("user", "partial user", false);
    expect(onTranscript).toHaveBeenCalledWith("assistant", "partial assistant", false);
    expect(onTranscript).toHaveBeenCalledWith("assistant", "final assistant text", true);
  });

  it.each([false, true])("handles zero-length playback with force=%s", async (force) => {
    const { bridge, socket, onClearAudio, onEvent } = await connectBridge({
      onClearAudio: vi.fn(),
      onEvent: vi.fn(),
    });
    bridge.setMediaTimestamp(1000);
    emitAssistantPlayback(socket);

    bridge.handleBargeIn?.({ audioPlaybackActive: true, ...(force ? { force } : {}) });
    if (force) {
      expect(parseSent(socket).slice(-2)).toEqual([
        expectedResponseCancelEvent(),
        truncation("item_1", 0),
      ]);
      expect(onClearAudio).toHaveBeenCalled();
    } else {
      expect(onClearAudio).not.toHaveBeenCalled();
      expect(hasSentEventType(socket, "response.cancel")).toBe(false);
      expect(hasSentEventType(socket, "conversation.item.truncate")).toBe(false);
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "conversation.item.truncate.skipped" }),
      );
    }
  });
});

type Bridge = ReturnType<typeof createNativeBridge>;
const outputsForCall = (socket: Socket, callId: string) =>
  sentOfType(socket, "conversation.item.create").filter(
    (event) => (event.item as { call_id?: string } | undefined)?.call_id === callId,
  );
const toolItem = (overrides: Record<string, unknown> = {}) => ({
  id: "item_tool_1",
  type: "function_call",
  status: "completed",
  call_id: "call_1",
  name: "lookup_weather",
  arguments: "{}",
  ...overrides,
});
const completedResponse = (output: unknown[]) => ({
  type: "response.done",
  response: { id: "response_1", status: "completed", output },
});
const numberedCalls = (length: number) =>
  Array.from({ length }, (_, index) => toolItem({ id: `item_${index}`, call_id: `call_${index}` }));
const submitWorkingResult = (bridge: Bridge) =>
  bridge.submitToolResult("call_1", { status: "working" }, { willContinue: true });
const submitDeliveredResult = (bridge: Bridge, callId = "call_1") =>
  bridge.submitToolResult(callId, { status: "already_delivered" }, { suppressResponse: true });
function connectToolBridge({
  onToolCall = vi.fn(),
  ...overrides
}: Parameters<typeof createNativeBridge>[0] = {}) {
  return connectBridge({ onToolCall, ...overrides });
}

describe("OpenAI realtime voice bridge tools", () => {
  beforeEach(resetTestState);
  afterEach(restoreTestEnvironment);

  it("dispatches valid successful response output once, ignoring provisional and unfinished items", async () => {
    const { socket, onToolCall } = await connectToolBridge();

    emitServerEvent(socket, {
      type: "response.function_call_arguments.delta",
      item_id: "item_tool_1",
      name: "openclaw_agent_consult",
      call_id: "call_1",
      delta: '{"question":"provisional',
    });
    emitServerEvent(socket, {
      type: "response.function_call_arguments.done",
      item_id: "item_tool_1",
      name: "openclaw_agent_consult",
      call_id: "call_1",
      arguments: '{"question":"still provisional"}',
    });
    emitServerEvent(socket, {
      type: "conversation.item.done",
      item: toolItem({
        status: undefined,
        name: "openclaw_agent_consult",
        arguments: '{"question":"not terminal"}',
      }),
    });
    expect(onToolCall).not.toHaveBeenCalled();

    const completed = completedResponse([
      toolItem({ name: "openclaw_agent_consult", arguments: '{"question":"delegate this"}' }),
      toolItem({ id: "empty-item", call_id: "empty-call", arguments: "" }),
      null,
      "invalid",
      toolItem({ status: "incomplete", call_id: "unfinished" }),
    ]);
    emitServerEvent(socket, completed);
    emitServerEvent(socket, completed);

    expect(onToolCall.mock.calls).toEqual([
      [
        {
          itemId: "item_tool_1",
          callId: "call_1",
          name: "openclaw_agent_consult",
          args: { question: "delegate this" },
        },
      ],
      [{ itemId: "empty-item", callId: "empty-call", name: "lookup_weather", args: {} }],
    ]);
  });

  it.each([
    { name: "malformed JSON", arguments: '{"city":', reason: "malformed-json" },
    { name: "JSON null", arguments: "null", reason: "non-object-json" },
    { name: "non-string arguments", arguments: { city: "Paris" }, reason: "invalid-json-type" },
  ])("rejects $name per call without ending the session", async ({ arguments: args, reason }) => {
    const onError = vi.fn();
    const onEvent = vi.fn();
    const { socket, onToolCall } = await connectToolBridge({ onError, onEvent });
    const completed = completedResponse([toolItem({ arguments: args })]);

    emitServerEvent(socket, { type: "response.created", response: { id: "response_1" } });
    emitServerEvent(socket, completed);
    emitServerEvent(socket, completed);

    expect(onToolCall).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledWith({
      direction: "server",
      type: "tool_call.arguments.rejected",
      detail: `reason=${reason}`,
      itemId: "item_tool_1",
    });
    expect(outputsForCall(socket, "call_1")).toHaveLength(1);
  });

  it("rejects 256001-byte multibyte UTF-8 arguments", async () => {
    const onError = vi.fn();
    const { socket, onToolCall } = await connectToolBridge({ onError });
    const rawArgs = `{"x":"${"é".repeat(127_996)}a"}`;
    expect(Buffer.byteLength(rawArgs, "utf8")).toBe(256_001);

    emitServerEvent(socket, completedResponse([toolItem({ arguments: rawArgs })]));

    expect(onToolCall).toHaveBeenCalledTimes(0);
    expect(outputsForCall(socket, "call_1")).not.toHaveLength(0);
    expect(onError).not.toHaveBeenCalled();
  });

  it("ends an extreme session before terminal tool-call ids become unbounded", async () => {
    const onError = vi.fn();
    const onClose = vi.fn();
    const { bridge, socket, onToolCall } = await connectToolBridge({ onError, onClose });

    emitServerEvent(socket, completedResponse(numberedCalls(1_025)));

    expect(onToolCall).toHaveBeenCalledTimes(1_024);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(
      new Error("OpenAI realtime tool-call session limit exceeded (1024)"),
    );
    expect(onClose).toHaveBeenCalledWith("error");
    expect(socket.closed).toBe(true);
    await expect(bridge.connect()).rejects.toThrow(
      "OpenAI realtime tool-call session limit exceeded (1024)",
    );
  });

  it("stops dispatching terminal output when a tool callback closes the bridge", async () => {
    const onToolCall = vi.fn();
    const bridge = createNativeBridge({ onToolCall });
    onToolCall.mockImplementation(() => bridge.close());
    const socket = await connectReadyBridge(bridge);

    emitServerEvent(socket, completedResponse(numberedCalls(2)));

    expect(onToolCall).toHaveBeenCalledTimes(1);
  });

  it("rejects undefined tool results without consuming a retryable call", async () => {
    const { bridge, socket } = await connectToolBridge();
    emitCompletedToolCalls(socket);
    const previousEventCount = socket.sent.length;

    expect(() => bridge.submitToolResult("call_1", undefined)).toThrow();
    expect(socket.sent).toHaveLength(previousEventCount);
    expect(hasSentEventType(socket, "response.create")).toBe(false);

    await bridge.submitToolResult("call_1", { recovered: true });

    expect(sentOfType(socket, "conversation.item.create")[0]).toEqual(
      expectedFunctionOutput("call_1", { recovered: true }),
    );
  });

  it("does not request a realtime response for suppressed tool results", async () => {
    const { bridge, socket } = await connectToolBridge();
    emitCompletedToolCalls(socket);

    submitDeliveredResult(bridge);

    expect(parseSent(socket).slice(-1)).toEqual([
      expectedFunctionOutput("call_1", { status: "already_delivered" }),
    ]);
    expect(hasSentEventType(socket, "response.create")).toBe(false);
  });

  it.each([false, true])(
    "waits for the final parallel result (suppressed=%s)",
    async (suppressed) => {
      const { bridge, socket } = await connectToolBridge();
      emitCompletedToolCalls(socket, ["call_1", "call_2"]);

      await bridge.submitToolResult("call_1", { text: "first" });

      expect(sentOfType(socket, "response.create")).toEqual([]);

      const second = suppressed
        ? submitDeliveredResult(bridge, "call_2")
        : bridge.submitToolResult("call_2", { text: "second" });
      await second;

      expect(sentOfType(socket, "conversation.item.create")).toHaveLength(2);
      expect(sentOfType(socket, "response.create")).toHaveLength(1);
    },
  );

  it("does not flush deferred response.create while a tool result is still continuing", async () => {
    const onError = vi.fn();
    const { bridge, socket } = await connectToolBridge({ onError });

    emitCompletedToolCalls(socket);
    await submitWorkingResult(bridge);
    expect(parseSent(socket).at(-1)).toEqual(
      expectedFunctionOutput("call_1", { status: "working" }),
    );
    expect(hasSentEventType(socket, "response.create")).toBe(false);
    bridge.sendUserMessage?.("queue after tool result");

    expect(onError).not.toHaveBeenCalled();
    expect(sentOfType(socket, "response.create")).toHaveLength(1);
    emitServerEvent(socket, { type: "response.created", response: { id: "resp_status" } });
    emitServerEvent(socket, {
      type: "response.done",
      response: { id: "resp_status", status: "completed", output: [] },
    });

    await bridge.submitToolResult("call_1", { text: "done" });

    expect(parseSent(socket).slice(-3)).toEqual(
      expectedToolContinuation("call_1", { text: "done" }),
    );
  });
});
