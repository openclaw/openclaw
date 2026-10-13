// Inworld tests cover inworld plugin behavior.
import { REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ } from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeInworldRealtimeProviderConfig } from "./realtime-voice-config.js";
import { buildInworldRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const { FakeWebSocket } = await vi.hoisted(() => import("./realtime-voice-socket.test-support.js"));

// mock-isolation: ws-runtime only exports the ws WebSocket client; tests swap in an in-memory fake so no network socket is ever opened.
vi.mock("./ws-runtime.js", () => ({
  WebSocket: FakeWebSocket,
}));

import {
  createTestBridge as buildTestBridge,
  type FakeWebSocketInstance,
  type TestBridgeOptions,
  openRealtimeBridge,
  parseSent,
  requireSession,
  startRealtimeBridge,
} from "./realtime-voice-provider.test-support.js";

const bridges: ReturnType<typeof buildTestBridge>[] = [];
function createTestBridge(options: Partial<TestBridgeOptions> = {}) {
  const bridge = buildTestBridge(options);
  bridges.push(bridge);
  return bridge;
}

function sent(socket: FakeWebSocketInstance, type: string) {
  return parseSent(socket).filter((event) => event.type === type);
}

async function connect(options: Partial<TestBridgeOptions> = {}) {
  const bridge = createTestBridge(options);
  const socket = await openRealtimeBridge(bridge, FakeWebSocket.instances.length);
  return { bridge, socket };
}

function audio(
  socket: FakeWebSocketInstance,
  itemId?: string,
  delta = Buffer.alloc(8000).toString("base64"),
) {
  socket.emitServer({ type: "response.output_audio.delta", item_id: itemId, delta });
}

function responseDone(socket: FakeWebSocketInstance, id?: string, status = "completed") {
  socket.emitServer({ type: "response.done", response: { id, status, output: [] } });
}

function socketHeaders(socket: FakeWebSocketInstance): Record<string, string> {
  const options = socket.args[1] as { headers?: Record<string, string> } | undefined;
  return options?.headers ?? {};
}

describe("buildInworldRealtimeVoiceProvider", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    delete process.env.INWORLD_API_KEY;
  });

  afterEach(() => {
    for (const bridge of bridges.splice(0)) {
      void bridge.close();
    }
    vi.useRealTimers();
  });

  it("exposes provider identity and detects configured credentials", () => {
    const provider = buildInworldRealtimeVoiceProvider();
    expect(provider.id).toBe("inworld");
    expect(provider.aliases).toContain("inworld-realtime");
    expect(provider.isConfigured({ providerConfig: {} })).toBe(false);
    expect(provider.isConfigured({ providerConfig: { apiKey: "k" } })).toBe(true); // pragma: allowlist secret
    process.env.INWORLD_API_KEY = "env-key"; // pragma: allowlist secret
    expect(provider.isConfigured({ providerConfig: {} })).toBe(true);
  });

  it("normalizes provider config with Inworld field aliases and ranges", () => {
    const config = normalizeInworldRealtimeProviderConfig({
      providers: {
        inworld: {
          apiKey: "k", // pragma: allowlist secret
          voice: "Luna",
          modelId: "inworld-tts-2-flash",
          speed: 1.3,
          deliveryMode: "creative",
          eagerness: "HIGH",
          turnDetection: "server_vad",
          responsiveness: true,
        },
      },
    });
    expect(config.voice).toBe("Luna");
    expect(config.ttsModel).toBe("inworld-tts-2-flash");
    expect(config.speakingRate).toBe(1.3);
    expect(config.deliveryMode).toBe("CREATIVE");
    expect(config.eagerness).toBe("high");
    expect(config.turnDetection).toBe("server_vad");
    expect(config.responsiveness).toBe(true);
    expect(
      normalizeInworldRealtimeProviderConfig({ speakingRate: 3 }).speakingRate,
    ).toBeUndefined();
    expect(() => normalizeInworldRealtimeProviderConfig({ deliveryMode: "loud" })).toThrow(
      /deliveryMode/,
    );
  });

  it("normalizes a bounded documented providerData passthrough", () => {
    const config = normalizeInworldRealtimeProviderConfig({
      apiKey: "k", // pragma: allowlist secret
      providerData: {
        memory: { enabled: true, turn_interval: 3 },
        stt: { voice_profile: true },
        tts: { timestamp_type: "WORD" },
        responsiveness: {},
      },
    });
    expect(config.providerData).toEqual({
      memory: { enabled: true, turn_interval: 3 },
      stt: { voice_profile: true },
      tts: { timestamp_type: "WORD" },
    });
    expect(
      normalizeInworldRealtimeProviderConfig({ providerData: {} }).providerData,
    ).toBeUndefined();
    expect(() =>
      normalizeInworldRealtimeProviderConfig({ providerData: { auto_tool_response: true } }),
    ).toThrow(/documented sections/);
    expect(() =>
      normalizeInworldRealtimeProviderConfig({ providerData: { metadata: { a: 1 } } }),
    ).toThrow(/unsupported: metadata/);
    expect(() =>
      normalizeInworldRealtimeProviderConfig({
        providerData: { memory: { note: "x".repeat(9000) } },
      }),
    ).toThrow(/exceeds/);
  });

  it("emits the passthrough in session.update under the typed fields with auto_tool_response pinned", async () => {
    const { socket } = await connect({
      providerConfig: {
        apiKey: "inworld-test", // pragma: allowlist secret
        deliveryMode: "CREATIVE",
        responsiveness: false,
        providerData: {
          memory: { enabled: true, turn_interval: 3, max_facts: 20 },
          stt: { voice_profile: true, min_end_of_turn_silence: 120 },
          tts: { delivery_mode: "STABLE", timestamp_type: "WORD" },
          responsiveness: { enabled: true, min_filler_gap_ms: 8000 },
        },
      },
    });
    const session = requireSession(socket);
    expect(session.providerData).toEqual({
      stt: { voice_profile: true, min_end_of_turn_silence: 120 },
      // Typed deliveryMode wins over the passthrough's delivery_mode; extra documented keys survive.
      tts: { timestamp_type: "WORD", delivery_mode: "CREATIVE" },
      memory: { enabled: true, turn_interval: 3, max_facts: 20 },
      // Typed responsiveness:false wins over the passthrough's enabled:true; the gap survives.
      responsiveness: { min_filler_gap_ms: 8000, enabled: false },
      auto_tool_response: false,
    });
  });

  it("connects with Basic auth to the Inworld session endpoint and sends the session policy", async () => {
    const tools = [
      {
        type: "function" as const,
        name: "openclaw_agent_consult",
        description: "Ask the agent",
        parameters: { type: "object" as const, properties: {} },
      },
    ];
    const { socket } = await connect({
      instructions: "Be brief.",
      language: "en",
      tools,
      audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      providerConfig: {
        apiKey: "inworld-test", // pragma: allowlist secret
        model: "openai/gpt-4.1-mini",
        voiceId: "Luna",
        ttsModel: "inworld-tts-2",
        speakingRate: 1.3,
        deliveryMode: "CREATIVE",
        eagerness: "high",
        responsiveness: true,
      },
    });
    const url = String(socket.args[0]);
    expect(url).toMatch(/^wss:\/\/api\.inworld\.ai\/api\/v1\/realtime\/session\?key=openclaw-/);
    expect(url).toContain("protocol=realtime");
    expect(socketHeaders(socket).Authorization).toBe("Basic inworld-test");

    const session = requireSession(socket);
    expect(session).toMatchObject({
      type: "realtime",
      model: "openai/gpt-4.1-mini",
      instructions: "Be brief.",
      output_modalities: ["audio"],
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24000 },
          transcription: { model: "inworld/inworld-stt-1", language: "en" },
          turn_detection: {
            type: "semantic_vad",
            eagerness: "high",
            create_response: true,
            interrupt_response: true,
          },
        },
        output: {
          format: { type: "audio/pcm", rate: 24000 },
          voice: "Luna",
          model: "inworld-tts-2",
          speed: 1.3,
        },
      },
      providerData: {
        auto_tool_response: false,
        tts: { delivery_mode: "CREATIVE" },
        responsiveness: { enabled: true },
      },
      tools,
      tool_choice: "auto",
    });
  });

  it("defaults to telephony mu-law, the Sarah voice and inworld-tts-2 when unset", async () => {
    const { socket } = await connect();
    const session = requireSession(socket);
    expect(session.model).toBeUndefined();
    expect(session).toMatchObject({
      audio: {
        input: { format: { type: "audio/pcmu" } },
        output: { format: { type: "audio/pcmu" }, voice: "Sarah", model: "inworld-tts-2" },
      },
    });
    expect((session.audio as { output: { speed?: number } }).output.speed).toBeUndefined();
  });

  it("uses server_vad thresholds when configured", async () => {
    const { socket } = await connect({
      providerConfig: {
        apiKey: "inworld-test", // pragma: allowlist secret
        turnDetection: "server_vad",
        vadThreshold: 0.7,
        silenceDurationMs: 800,
        prefixPaddingMs: 200,
      },
    });
    expect(requireSession(socket)).toMatchObject({
      audio: {
        input: {
          turn_detection: {
            type: "server_vad",
            threshold: 0.7,
            silence_duration_ms: 800,
            prefix_padding_ms: 200,
            create_response: true,
            interrupt_response: true,
          },
        },
      },
    });
  });

  it("rejects startup when no credential is available", async () => {
    const bridge = createTestBridge({ providerConfig: {} });
    await expect(bridge.connect()).rejects.toThrow(/Inworld credentials missing/);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("rejects startup on a server error before session.updated", async () => {
    const bridge = createTestBridge();
    const connecting = bridge.connect();
    const socket = await FakeWebSocket.waitForInstance(0);
    socket.open();
    socket.emitServer({ type: "error", error: { message: "Invalid authorization credentials" } });
    await expect(connecting).rejects.toThrow(/Invalid authorization credentials/);
  });

  it("queues audio until ready, then streams input_audio_buffer.append", async () => {
    const bridge = createTestBridge();
    bridge.sendAudio(Buffer.from([1, 2, 3]));
    const { connecting, socket } = await startRealtimeBridge(bridge, 0);
    await connecting;
    bridge.sendAudio(Buffer.from([4, 5, 6]));
    const appends = sent(socket, "input_audio_buffer.append");
    expect(appends.map((event) => event.audio)).toEqual([
      Buffer.from([1, 2, 3]).toString("base64"),
      Buffer.from([4, 5, 6]).toString("base64"),
    ]);
  });

  it("delivers output audio with playback marks and reports transcripts", async () => {
    const onAudio = vi.fn();
    const onMark = vi.fn();
    const onTranscript = vi.fn();
    const onReady = vi.fn();
    const { socket } = await connect({ onAudio, onMark, onTranscript, onReady });
    expect(onReady).toHaveBeenCalledTimes(1);
    socket.emitServer({ type: "response.created", response: { id: "r1" } });
    audio(socket, "item-1");
    expect(onAudio).toHaveBeenCalledTimes(1);
    expect(onAudio.mock.calls[0]?.[1]).toEqual({ itemId: "item-1" });
    expect(onMark).toHaveBeenCalledTimes(1);
    socket.emitServer({ type: "response.output_audio_transcript.delta", delta: "Hel" });
    socket.emitServer({ type: "response.output_audio_transcript.done", transcript: "Hello" });
    expect(onTranscript).toHaveBeenCalledWith("assistant", "Hel", false);
    expect(onTranscript).toHaveBeenCalledWith("assistant", "Hello", true);
    socket.emitServer({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "u1",
      transcript: "hi there",
    });
    responseDone(socket, "r1");
    expect(onTranscript).toHaveBeenCalledWith("user", "hi there", true, { textMode: "snapshot" });
  });

  it("emits completed tool calls at response.done and returns results with response.create", async () => {
    const onToolCall = vi.fn();
    const { bridge, socket } = await connect({ onToolCall });
    socket.emitServer({ type: "response.created", response: { id: "r1" } });
    socket.emitServer({
      type: "response.function_call_arguments.done",
      item_id: "fc-1",
      call_id: "call-1",
      name: "openclaw_agent_consult",
      arguments: JSON.stringify({ question: "what time is it" }),
    });
    expect(onToolCall).not.toHaveBeenCalled();
    socket.emitServer({
      type: "response.done",
      response: {
        id: "r1",
        status: "completed",
        output: [
          {
            id: "fc-1",
            type: "function_call",
            status: "completed",
            call_id: "call-1",
            name: "openclaw_agent_consult",
            arguments: JSON.stringify({ question: "what time is it" }),
          },
        ],
      },
    });
    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(onToolCall.mock.calls[0]?.[0]).toMatchObject({
      callId: "call-1",
      name: "openclaw_agent_consult",
      args: { question: "what time is it" },
    });
    void bridge.submitToolResult("call-1", { answer: "noon" });
    const outputs = sent(socket, "conversation.item.create");
    expect(outputs.at(-1)?.item).toMatchObject({
      type: "function_call_output",
      call_id: "call-1",
      output: JSON.stringify({ answer: "noon" }),
    });
    expect(sent(socket, "response.create")).toHaveLength(1);
  });

  it("does not start a response for a suppressed tool result", async () => {
    const { bridge, socket } = await connect();
    socket.emitServer({ type: "response.created", response: { id: "r1" } });
    responseDone(socket, "r1");
    void bridge.submitToolResult("call-9", { ok: true }, { suppressResponse: true });
    expect(sent(socket, "conversation.item.create")).toHaveLength(1);
    expect(sent(socket, "response.create")).toHaveLength(0);
  });

  it("does not expose back-channel: typed key and providerData section are rejected", () => {
    expect(
      () => normalizeInworldRealtimeProviderConfig({ apiKey: "k", backchannel: true }), // pragma: allowlist secret
    ).toThrow(/backchannel is not supported yet/);
    expect(() =>
      normalizeInworldRealtimeProviderConfig({ providerData: { backchannel: { enabled: true } } }),
    ).toThrow(/unsupported: backchannel/);
  });

  it("tolerates back-channel events without delivering audio, marks, state changes or truncation", async () => {
    const onAudio = vi.fn();
    const onMark = vi.fn();
    const onEvent = vi.fn();
    const playback: { itemId: string; audioEndMs: number }[] = [];
    const { bridge, socket } = await connect({
      onAudio: (_audio, metadata) => {
        onAudio(metadata);
        if (metadata?.itemId) {
          playback.push({ itemId: metadata.itemId, audioEndMs: 10 });
        }
      },
      onMark,
      onEvent,
      getPlaybackState: () => playback,
    });
    socket.emitServer({ type: "response.created", response: { id: "r1" } });
    responseDone(socket, "r1");
    const chunk = Buffer.alloc(160, 7).toString("base64");
    socket.emitServer({
      type: "response.backchannel.audio.delta",
      backchannel_id: "bc-1",
      delta: chunk,
    });
    socket.emitServer({
      type: "response.backchannel.audio.done",
      backchannel_id: "bc-1",
      phrase: "uh-huh",
    });
    socket.emitServer({ type: "response.backchannel.skipped", reason: "no_phrase" });
    expect(onAudio).not.toHaveBeenCalled();
    expect(onMark).not.toHaveBeenCalled();
    expect(playback).toEqual([]);
    socket.emitServer({ type: "input_audio_buffer.speech_started" });
    expect(sent(socket, "conversation.item.truncate")).toEqual([]);
    bridge.sendUserMessage?.("go on");
    expect(sent(socket, "response.create")).toHaveLength(1);
    const types = onEvent.mock.calls.map((call) => (call[0] as { type: string }).type);
    expect(types).toContain("response.backchannel.audio.delta");
    const done = onEvent.mock.calls.find(
      (call) => (call[0] as { type: string }).type === "response.backchannel.audio.done",
    )?.[0] as { detail?: string };
    expect(done.detail).toContain("backchannelId=bc-1");
  });

  it("clears playback and cancels the response when the server reports user speech", async () => {
    const onClearAudio = vi.fn();
    const { socket } = await connect({ onClearAudio });
    socket.emitServer({ type: "response.created", response: { id: "r1" } });
    audio(socket, "item-1");
    socket.emitServer({ type: "input_audio_buffer.speech_started" });
    expect(onClearAudio).toHaveBeenCalledWith("barge-in");
    // Inworld's turn detection cancels server-side; the host only truncates and clears.
    expect(sent(socket, "response.cancel")).toHaveLength(0);
  });

  it("cancels and truncates on a host barge-in during an active response", async () => {
    const onClearAudio = vi.fn();
    const { bridge, socket } = await connect({ onClearAudio });
    socket.emitServer({ type: "response.created", response: { id: "r1" } });
    bridge.setMediaTimestamp(0);
    audio(socket, "item-1");
    bridge.setMediaTimestamp(120);
    bridge.handleBargeIn?.({ audioPlaybackActive: true });
    expect(sent(socket, "response.cancel")).toHaveLength(1);
    const truncate = sent(socket, "conversation.item.truncate")[0];
    expect(truncate?.item_id).toBe("item-1");
    expect(truncate?.audio_end_ms).toBeGreaterThan(0);
    expect(onClearAudio).toHaveBeenCalledWith("barge-in");
  });

  it.each([
    { format: undefined, bytesPerMs: 8 },
    { format: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ, bytesPerMs: 48 },
  ])(
    "clamps native playback to each item's produced audio ($bytesPerMs bytes/ms)",
    async ({ format, bytesPerMs }) => {
      const playback = [
        { itemId: "older-item", audioEndMs: 9000 },
        { itemId: "current-item", audioEndMs: 6177 },
      ];
      const { bridge, socket } = await connect({
        audioFormat: format,
        getPlaybackState: () => playback,
      });
      socket.emitServer({ type: "response.created", response: { id: "r1" } });
      audio(socket, "older-item", Buffer.alloc(1000 * bytesPerMs).toString("base64"));
      responseDone(socket, "r1");
      socket.emitServer({ type: "response.created", response: { id: "r2" } });
      audio(socket, "current-item", Buffer.alloc(1000 * bytesPerMs).toString("base64"));
      audio(socket, "current-item", Buffer.alloc(1619 * bytesPerMs).toString("base64"));
      bridge.handleBargeIn?.({ audioPlaybackActive: true });
      expect(sent(socket, "conversation.item.truncate")).toEqual([
        {
          type: "conversation.item.truncate",
          item_id: "older-item",
          content_index: 0,
          audio_end_ms: bytesPerMs === 8 ? 333 : 1000,
        },
        {
          type: "conversation.item.truncate",
          item_id: "current-item",
          content_index: 0,
          audio_end_ms: bytesPerMs === 8 ? 873 : 2619,
        },
      ]);
    },
  );

  it("resets the produced bound when a successor response reuses an item ID", async () => {
    const playback = [{ itemId: "reused-item", audioEndMs: 6177 }];
    const { socket } = await connect({ getPlaybackState: () => playback });
    socket.emitServer({ type: "response.created", response: { id: "r1" } });
    audio(socket, "reused-item", Buffer.alloc(8000 * 8).toString("base64"));
    responseDone(socket, "r1");
    socket.emitServer({ type: "response.created", response: { id: "r2" } });
    audio(socket, "reused-item", Buffer.alloc(2619 * 8).toString("base64"));
    socket.emitServer({ type: "input_audio_buffer.speech_started" });
    expect(sent(socket, "conversation.item.truncate")).toEqual([
      {
        type: "conversation.item.truncate",
        item_id: "reused-item",
        content_index: 0,
        audio_end_ms: 873,
      },
    ]);
  });

  it("reports the response outcome and an unexpected close as terminal", async () => {
    const onResponseDone = vi.fn();
    const onClose = vi.fn();
    const onEvent = vi.fn();
    const { bridge, socket } = await connect({ onResponseDone, onClose, onEvent });
    socket.emitServer({ type: "response.created", response: { id: "r1" } });
    responseDone(socket, "r1", "cancelled");
    expect(onResponseDone).toHaveBeenCalledWith(expect.objectContaining({ status: "cancelled" }));
    socket.close(1006, "connection lost");
    expect(onClose).toHaveBeenCalledWith("error");
    expect(bridge.isConnected()).toBe(false);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "session.closed", direction: "client" }),
    );
  });

  it("closes cleanly on request", async () => {
    const onClose = vi.fn();
    const { bridge, socket } = await connect({ onClose });
    void bridge.close();
    expect(socket.closed).toBe(true);
    expect(onClose).toHaveBeenCalledWith("completed");
    expect(bridge.isConnected()).toBe(false);
  });

  it("refuses requests that disable automatic responses or interruption", () => {
    const provider = buildInworldRealtimeVoiceProvider();
    expect(() =>
      provider.createBridge({
        providerConfig: { apiKey: "k" }, // pragma: allowlist secret
        onAudio: vi.fn(),
        onClearAudio: vi.fn(),
        autoRespondToAudio: false,
      }),
    ).toThrow(/automatic turn-detection responses/);
    expect(() =>
      provider.createBridge({
        providerConfig: { apiKey: "k" }, // pragma: allowlist secret
        onAudio: vi.fn(),
        onClearAudio: vi.fn(),
        interruptResponseOnInputAudio: false,
      }),
    ).toThrow(/interruption handling/);
  });
});
