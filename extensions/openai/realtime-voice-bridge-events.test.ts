import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const mocks = await vi.hoisted(async () => {
  const { createOpenAIRealtimeMockState } = await import("./realtime-voice-test-support.js");
  return createOpenAIRealtimeMockState();
});
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: mocks.execFileSyncMock };
});

vi.mock("ws", () => ({ default: mocks.FakeWebSocket }));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: mocks.fetchWithSsrFGuardMock,
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
const completed = (socket: Socket, id: string) =>
  emitServerEvent(socket, { type: "response.done", response: { id, status: "completed" } });
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
async function connectBridge(overrides: Parameters<typeof createNativeBridge>[0]) {
  const bridge = createNativeBridge(overrides);
  return { bridge, socket: await connectReadyBridge(bridge) };
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
    const onMark = vi.fn();
    const { bridge, socket } = await connectBridge({ onMark });
    bridge.setMediaTimestamp(1000);
    emitAssistantPlayback(socket, {
      responseId: "response-a",
      itemId: "audio-a",
      audio: Buffer.alloc(8000),
    });
    completed(socket, "response-a");
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
    const onMark = vi.fn();
    const { bridge, socket: firstSocket } = await connectBridge({ onMark });
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

  it("truncates audible and queued native items using sink progress", async () => {
    const onAudio = vi.fn();
    const { bridge, socket } = await connectBridge({
      onAudio,
      ...playbackSink(["audible", 620], ["queued", 0]),
    });
    for (const itemId of ["audible", "queued"]) {
      created(socket, itemId);
      emitServerEvent(socket, audioDelta(itemId, 8_000, itemId));
      completed(socket, itemId);
    }
    emitServerEvent(socket, { type: "input_audio_buffer.speech_started" });
    expectTruncations(socket, ["audible", 620], ["queued", 0]);
    expect(onAudio).toHaveBeenLastCalledWith(Buffer.alloc(8_000), { itemId: "queued" });
    bridge.handleBargeIn?.({ audioPlaybackActive: true, force: true });
    expect(sentOfType(socket, "conversation.item.truncate")).toHaveLength(2);
    await bridge.close();
  });

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
    const onAudio = vi.fn();
    const { bridge, socket } = await connectBridge({ getPlaybackState: () => [], onAudio });
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
      const onAudio = vi.fn();
      const { bridge, socket } = await connectBridge({
        onAudio,
        getPlaybackState: () => [],
        onEvent: (event) => {
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
    const { bridge, socket } = await connectBridge({
      ...sink,
      onEvent: (event) => {
        if (event.direction === "client" && event.type === "response.cancel" && !repeated) {
          repeated = true;
          bridge.handleBargeIn?.({ force: true });
        }
      },
    });
    created(socket, "native");
    bridge.handleBargeIn?.({ force: true });
    expect(sentOfType(socket, "response.cancel")).toHaveLength(1);
    expectTruncations(socket, ["audible", 620], ["queued", 0]);
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

  it("truncates externally interrupted playback at the produced duration", async () => {
    const producedAudioMs = 300;
    const onAudio = vi.fn();
    const onClearAudio = vi.fn();
    const { bridge, socket } = await connectBridge({
      onAudio,
      onClearAudio,
      onMark: () => bridge.acknowledgeMark(),
    });

    bridge.setMediaTimestamp(1000);
    emitAssistantPlayback(socket, { audio: Buffer.alloc(producedAudioMs * 8) });
    bridge.setMediaTimestamp(1000 + producedAudioMs);

    bridge.handleBargeIn?.({ audioPlaybackActive: true });

    expect(onAudio).toHaveBeenCalledTimes(1);
    expect(onClearAudio).toHaveBeenCalledWith("barge-in");
    expect(truncations(socket).at(-1)).toEqual(truncation("item_1", producedAudioMs));
    expect(parseSent(socket).some((event) => event.type === "response.cancel")).toBe(true);
  });

  it("preserves FIFO playback acknowledgements after sustained output", async () => {
    const onClearAudio = vi.fn();
    const onMark = vi.fn();
    const { bridge, socket } = await connectBridge({ onClearAudio, onMark });

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
    const onError = vi.fn();
    const onEvent = vi.fn();
    const { socket } = await connectBridge({ onError, onEvent });

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
    const onTranscript = vi.fn();
    const { socket } = await connectBridge({ onTranscript });

    emitServerEvent(socket, { type: "response.text.delta", delta: "draft assistant" });
    emitServerEvent(socket, { type: "response.text.done", text: "corrected assistant" });

    expect(onTranscript.mock.calls).toEqual([
      ["assistant", "draft assistant", false],
      ["assistant", "corrected assistant", true],
    ]);
  });

  it("forwards Codex-compatible legacy realtime audio and transcript events", async () => {
    const onAudio = vi.fn();
    const onTranscript = vi.fn();
    const { socket } = await connectBridge({ onAudio, onTranscript });

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

  it("ignores zero-length playback barge-in without clearing audio", async () => {
    const onClearAudio = vi.fn();
    const onEvent = vi.fn();
    const { bridge, socket } = await connectBridge({ onClearAudio, onEvent });
    bridge.setMediaTimestamp(1000);
    emitAssistantPlayback(socket);

    bridge.handleBargeIn?.({ audioPlaybackActive: true });

    expect(onClearAudio).not.toHaveBeenCalled();
    expect(hasSentEventType(socket, "response.cancel")).toBe(false);
    expect(hasSentEventType(socket, "conversation.item.truncate")).toBe(false);
    expect(onEvent).toHaveBeenCalledWith({
      direction: "client",
      type: "conversation.item.truncate.skipped",
      detail: "reason=barge-in audioEndMs=0 minAudioEndMs=250",
    });
  });

  it("force-cancels zero-length playback barge-in for agent handoff fallback", async () => {
    const onClearAudio = vi.fn();
    const onEvent = vi.fn();
    const { bridge, socket } = await connectBridge({ onClearAudio, onEvent });
    bridge.setMediaTimestamp(1000);
    emitAssistantPlayback(socket);

    bridge.handleBargeIn?.({ audioPlaybackActive: true, force: true });

    expect(parseSent(socket).slice(-2)).toEqual([
      expectedResponseCancelEvent(),
      truncation("item_1", 0),
    ]);
    expect(onClearAudio).toHaveBeenCalled();
    expect(
      onEvent.mock.calls.some(
        ([event]) => isRecord(event) && event.type === "conversation.item.truncate.skipped",
      ),
    ).toBe(false);
  });
});
