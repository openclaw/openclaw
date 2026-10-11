import { REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ } from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { XAI_REALTIME_MAX_PENDING_PLAYBACK_MARKS } from "./realtime-voice-config.js";
import { buildXaiRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const { FakeWebSocket, isProviderAuthProfileConfiguredAsyncMock, resolveApiKeyForProviderMock } =
  await vi.hoisted(() => import("./realtime-voice-socket.test-support.js"));

vi.mock("./ws-runtime.js", () => ({
  WebSocket: FakeWebSocket,
}));

vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  isProviderAuthProfileConfigured: () => false,
  isProviderAuthProfileConfiguredAsync: isProviderAuthProfileConfiguredAsyncMock,
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

import {
  createTestBridge as buildTestBridge,
  type FakeWebSocketInstance,
  type TestBridgeOptions,
  openRealtimeBridge,
  parseSent,
  requireSession,
  requireSocket,
  startRealtimeBridge,
  waitForRealtimeState,
} from "./realtime-voice-provider.test-support.js";

const bridges: ReturnType<typeof buildTestBridge>[] = [];
function createTestBridge(options: Partial<TestBridgeOptions> = {}) {
  const bridge = buildTestBridge(options);
  bridges.push(bridge);
  return bridge;
}

const resumingConfig = { apiKey: "xai-test", sessionResumption: true }; // pragma: allowlist secret

function sent(socket: FakeWebSocketInstance, type: string) {
  return parseSent(socket).filter((event) => event.type === type);
}

async function connect(options: Partial<TestBridgeOptions> = {}, conversationId?: string) {
  const bridge = createTestBridge(options);
  const socket = await openRealtimeBridge(bridge, FakeWebSocket.instances.length, conversationId);
  return { bridge, socket };
}

async function reconnect(socket: FakeWebSocketInstance) {
  const index = FakeWebSocket.instances.length;
  socket.close(1006, "connection lost");
  await vi.advanceTimersByTimeAsync(1000);
  await waitForRealtimeState(() => expect(FakeWebSocket.instances).toHaveLength(index + 1));
  return requireSocket(index);
}

function audio(
  socket: FakeWebSocketInstance,
  itemId?: string,
  delta = Buffer.alloc(8000).toString("base64"),
) {
  socket.emitServer({ type: "response.output_audio.delta", item_id: itemId, delta });
}

function inputTranscript(socket: FakeWebSocketInstance, transcript: string, itemId?: string) {
  socket.emitServer({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: itemId,
    transcript,
  });
}

function responseDone(socket: FakeWebSocketInstance, id?: string, status = "completed") {
  socket.emitServer({ type: "response.done", response: { id, status } });
}

async function openTranscriptBridge() {
  const onTranscript = vi.fn();
  const bridge = createTestBridge({ onTranscript });
  return { socket: await openRealtimeBridge(bridge), onTranscript };
}

function toolArguments(
  socket: FakeWebSocketInstance,
  itemId: string,
  callId: string,
  args = "{}",
  name = "openclaw_agent_consult",
) {
  socket.emitServer({
    type: "response.function_call_arguments.done",
    item_id: itemId,
    call_id: callId,
    name,
    arguments: args,
  });
}

function userMessageEvent(text: string) {
  return {
    type: "conversation.item.create",
    item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  };
}

function toolResultEvent(callId: string, result: unknown) {
  return {
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: callId,
      output: JSON.stringify(result),
    },
  };
}

describe("buildXaiRealtimeVoiceProvider", () => {
  it("retires unheard playback marks after a failed native terminal", async () => {
    const onMark = vi.fn();
    const { bridge, socket } = await connect({ onMark });
    socket.emitServer({ type: "response.created" });
    audio(socket, "discarded");
    bridge.sendUserMessage?.("next response");
    expect(sent(socket, "response.create")).toEqual([]);
    responseDone(socket, undefined, "failed");
    expect(sent(socket, "response.create")).toEqual([{ type: "response.create" }]);
    const oldAcknowledgment = onMark.mock.calls[0]?.[1];
    expect(oldAcknowledgment).toBeTypeOf("function");
    oldAcknowledgment();
    expect(sent(socket, "response.create")).toHaveLength(1);
  });

  beforeEach(() => {
    FakeWebSocket.instances = [];
    isProviderAuthProfileConfiguredAsyncMock.mockReset();
    isProviderAuthProfileConfiguredAsyncMock.mockResolvedValue(false);
    resolveApiKeyForProviderMock.mockReset();
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: undefined });
    delete process.env.XAI_API_KEY;
    vi.unstubAllEnvs();
  });

  afterEach(async () => {
    for (const bridge of bridges.splice(0)) {
      await bridge.close();
    }
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  describe("xAI sink-owned playback interruption", () => {
    it.each(["response.created", "response.output_audio.delta"])(
      "allows the %s observer to cancel before PCM delivery",
      async (interruptOn) => {
        const onAudio = vi.fn();
        const bridge = createTestBridge({
          onAudio,
          getPlaybackState: () => [],
          onEvent: (event) => {
            if (event.direction === "server" && event.type === interruptOn) {
              bridge.handleBargeIn?.({ force: true });
            }
          },
        });
        const socket = await openRealtimeBridge(bridge);
        socket.emitServer({ type: "response.created", response: { id: "native" } });
        audio(socket, "native");
        expect(onAudio).not.toHaveBeenCalled();
        expect(sent(socket, "response.cancel")).toHaveLength(1);
      },
    );

    it("sends no later frames when the cancellation observer closes the bridge", async () => {
      const bridge = createTestBridge({
        getPlaybackState: () => [{ itemId: "interrupted", audioEndMs: 500 }],
        onEvent: (event) => {
          if (event.direction === "client" && event.type === "response.cancel") {
            void bridge.close();
          }
        },
      });
      const socket = await openRealtimeBridge(bridge);
      socket.emitServer({ type: "response.created", response: { id: "native" } });
      const sentCount = socket.sent.length;
      expect(() => bridge.handleBargeIn?.({ force: true })).not.toThrow();
      expect(socket.closed).toBe(true);
      expect(socket.sent).toHaveLength(sentCount + 1);
      expect(parseSent(socket).at(-1)?.type).toBe("response.cancel");
    });

    it("interrupts each playback item once when its truncate observer repeats control", async () => {
      let playback = [
        { itemId: "audible", audioEndMs: 620 },
        { itemId: "queued", audioEndMs: 0 },
      ];
      let repeated = false;
      const onClearAudio = vi.fn(() => {
        playback = [];
      });
      const bridge = createTestBridge({
        getPlaybackState: () => playback,
        onClearAudio,
        onEvent: (event) => {
          if (
            event.direction === "client" &&
            event.type === "conversation.item.truncate" &&
            !repeated
          ) {
            repeated = true;
            bridge.handleBargeIn?.({ force: true });
          }
        },
      });
      const socket = await openRealtimeBridge(bridge);
      socket.emitServer({ type: "response.created", response: { id: "native" } });
      bridge.handleBargeIn?.({ force: true });
      expect(sent(socket, "response.cancel")).toHaveLength(1);
      expect(sent(socket, "conversation.item.truncate")).toEqual([
        {
          type: "conversation.item.truncate",
          item_id: "audible",
          content_index: 0,
          audio_end_ms: 620,
        },
        {
          type: "conversation.item.truncate",
          item_id: "queued",
          content_index: 0,
          audio_end_ms: 0,
        },
      ]);
      expect(onClearAudio).toHaveBeenCalledOnce();
    });

    it("does not publish marks or late PCM after the audio callback cancels", async () => {
      let playback = [{ itemId: "current", audioEndMs: 0 }];
      const onMark = vi.fn();
      const onAudio = vi.fn(() =>
        bridge.handleBargeIn?.({ audioPlaybackActive: true, force: true }),
      );
      const bridge = createTestBridge({
        onAudio,
        onMark,
        getPlaybackState: () => playback,
        onClearAudio: () => {
          playback = [];
        },
      });
      const socket = await openRealtimeBridge(bridge);
      socket.emitServer({ type: "response.created", response: { id: "current" } });
      const deltaEvent = {
        type: "response.output_audio.delta",
        item_id: "current",
        delta: Buffer.alloc(8_000).toString("base64"),
      };
      socket.emitServer(deltaEvent);
      socket.emitServer(deltaEvent);
      expect(onAudio).toHaveBeenCalledOnce();
      expect(onMark).not.toHaveBeenCalled();
    });
  });

  it("requires xAI credentials for native realtime websocket bridges", async () => {
    const bridge = createTestBridge({
      cfg: {},
      providerConfig: { model: "grok-voice-latest" },
    });

    await expect(bridge.connect()).rejects.toThrow("xAI credentials missing for realtime voice");
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("resolves realtime auth from the selected agent directory", async () => {
    isProviderAuthProfileConfiguredAsyncMock.mockImplementation(
      async ({ agentDir }) => agentDir === "/tmp/openclaw-molty-agent",
    );
    resolveApiKeyForProviderMock.mockImplementation(async ({ agentDir }) => ({
      apiKey: agentDir === "/tmp/openclaw-molty-agent" ? "xai-molty" : undefined,
    }));
    const cfg = {
      agents: {
        entries: {
          helper: { agentDir: "/tmp/openclaw-helper-agent" },
          molty: { agentDir: "/tmp/openclaw-molty-agent" },
        },
      },
    };
    expect(
      await buildXaiRealtimeVoiceProvider().isConfiguredAsync?.({
        cfg,
        providerConfig: {},
        agentId: "molty",
      }),
    ).toBe(true);
    const bridge = createTestBridge({ cfg, agentId: "molty", providerConfig: {} });
    const { connecting, socket } = await startRealtimeBridge(bridge);
    await connecting;
    await bridge.close();
    expect(resolveApiKeyForProviderMock).toHaveBeenCalledWith({
      provider: "xai",
      cfg,
      agentDir: "/tmp/openclaw-molty-agent",
    });
    expect((socket.args[1] as { headers?: Record<string, string> }).headers?.Authorization).toBe(
      "Bearer xai-molty",
    );
  });

  it("arms the socket timeout only after async credentials resolve", async () => {
    vi.useFakeTimers();
    let resolveCredentials: ((value: { apiKey: string }) => void) | undefined;
    resolveApiKeyForProviderMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCredentials = resolve;
        }),
    );
    const bridge = createTestBridge({ cfg: {}, providerConfig: {} });
    const connecting = bridge.connect();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeWebSocket.instances).toHaveLength(0);
    resolveCredentials?.({ apiKey: "xai-oauth" });
    await vi.advanceTimersByTimeAsync(0);
    const socket = requireSocket();
    const rejected = expect(connecting).rejects.toThrow("xAI realtime voice connection timeout");
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(socket.terminated).toBe(true);
    expect(bridge.isConnected()).toBe(false);
  });

  it("starts a replacement immediately after canceling pending credentials", async () => {
    const onClose = vi.fn();
    let resolveFirstCredentials: ((value: { apiKey: string | undefined }) => void) | undefined;
    resolveApiKeyForProviderMock
      .mockImplementationOnce(
        () =>
          new Promise<{ apiKey: string | undefined }>((resolve) => {
            resolveFirstCredentials = resolve;
          }),
      )
      .mockResolvedValue({ apiKey: "xai-replacement" }); // pragma: allowlist secret
    const bridge = createTestBridge({ cfg: {}, onClose, providerConfig: {} });
    const canceledConnect = bridge.connect();
    await waitForRealtimeState(() => expect(resolveApiKeyForProviderMock).toHaveBeenCalledOnce());
    void bridge.close();
    void bridge.close();
    const replacementConnect = bridge.connect();

    await waitForRealtimeState(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const replacementSocket = requireSocket();
    replacementSocket.open();
    replacementSocket.emitServer({ type: "session.updated" });
    await Promise.all([canceledConnect, replacementConnect]);
    expect(bridge.isConnected()).toBe(true);
    expect(onClose).toHaveBeenCalledExactlyOnceWith("completed");
    resolveFirstCredentials?.({ apiKey: "xai-late" }); // pragma: allowlist secret
    await waitForRealtimeState(() => expect(FakeWebSocket.instances).toHaveLength(1));
  });

  it("ignores late events from a canceled socket after replacement", async () => {
    const onAudio = vi.fn();
    const onClose = vi.fn();
    const onError = vi.fn();
    const onReady = vi.fn();
    const bridge = createTestBridge({ onAudio, onClose, onError, onReady });
    const firstConnect = bridge.connect();
    await waitForRealtimeState(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const staleSocket = requireSocket();
    staleSocket.deferClose = true;
    void bridge.close();
    void bridge.close();
    await firstConnect;
    const replacementConnect = bridge.connect();
    await waitForRealtimeState(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const replacementSocket = requireSocket(1);
    replacementSocket.open();
    replacementSocket.emitServer({ type: "session.updated" });
    await replacementConnect;

    staleSocket.emit("open");
    staleSocket.emitServer({ type: "session.updated" });
    staleSocket.emitServer({
      type: "response.output_audio.delta",
      delta: Buffer.from("late audio").toString("base64"),
    });
    staleSocket.emit("error", new Error("late socket error"));
    staleSocket.flushClose();
    expect(bridge.isConnected()).toBe(true);
    expect(onReady).toHaveBeenCalledOnce();
    expect(onAudio).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith("completed");
  });

  it("rejects session readiness after its event callback closes the bridge", async () => {
    const onClose = vi.fn();
    const onReady = vi.fn();
    const bridge = createTestBridge({
      onClose,
      onReady,
      onEvent: (event) => {
        if (event.direction === "server" && event.type === "session.updated") {
          void bridge.close();
        }
      },
    });
    const connecting = bridge.connect();
    await waitForRealtimeState(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = requireSocket();
    socket.open();
    socket.emitServer({ type: "session.updated" });
    await connecting;
    expect(bridge.isConnected()).toBe(false);
    expect(onReady).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith("completed");
  });

  it("uses XAI_API_KEY for default Grok realtime bridges", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-env"); // pragma: allowlist secret
    const bridge = createTestBridge({
      cfg: {},
      providerConfig: {
        model: "grok-voice-latest",
        voice: "ara",
        vadThreshold: 0.9,
        silenceDurationMs: 10000,
        prefixPaddingMs: 0,
        reasoningEffort: "none",
      },
      instructions: "Speak briefly.",
      tools: [
        {
          type: "function",
          name: "lookup",
          description: "Lookup",
          parameters: { type: "object", properties: {} },
        },
      ],
    });
    const { socket } = await startRealtimeBridge(bridge);
    await bridge.close();
    const url = socket.args[0] as string;
    expect(url).toContain("wss://api.x.ai/v1/realtime?model=grok-voice-latest");
    const options = socket?.args[1] as { headers?: Record<string, string> } | undefined;
    expect(options?.headers?.Authorization).toBe("Bearer xai-env");
    expect(options).toEqual(expect.objectContaining({ maxPayload: 16 * 1024 * 1024 }));
    const session = requireSession(socket);
    expect(session.voice).toBe("ara");
    expect(session.reasoning).toEqual({ effort: "none" });
    expect(session.resumption).toBeUndefined();
    expect(session.tools).toHaveLength(1);
    expect(session.tool_choice).toBe("auto");
    expect(session.turn_detection).toEqual({
      type: "server_vad",
      threshold: 0.9,
      prefix_padding_ms: 0,
      silence_duration_ms: 10000,
    });
    expect(session.audio).toEqual({
      input: {
        format: { type: "audio/pcmu" },
        transcription: { model: "grok-transcribe" },
      },
      output: { format: { type: "audio/pcmu" } },
    });
  });

  it("copies pending realtime audio views without retaining their backing allocation", async () => {
    const bridge = createTestBridge();
    const backing = Buffer.alloc(2 * 1024 * 1024, 0x7f);
    const view = backing.subarray(0, 1);

    bridge.sendAudio(view);
    backing[0] = 0;
    const socket = await openRealtimeBridge(bridge);
    expect(sent(socket, "input_audio_buffer.append")).toEqual([
      { type: "input_audio_buffer.append", audio: "fw==" },
    ]);
  });

  it("drops queued realtime input on close and ignores late input until reconnect", async () => {
    const bridge = createTestBridge();

    bridge.sendAudio(Buffer.from([0x01]));
    bridge.sendUserMessage?.("queued before close");
    void bridge.submitToolResult("call-before-close", { ok: true });
    void bridge.close();
    bridge.sendAudio(Buffer.from([0x02]));
    bridge.sendUserMessage?.("late after close");
    void bridge.submitToolResult("call-after-close", { ok: true });
    const socket = await openRealtimeBridge(bridge);
    expect(
      parseSent(socket).filter(
        (event) =>
          event.type === "input_audio_buffer.append" ||
          event.type === "conversation.item.create" ||
          event.type === "response.create",
      ),
    ).toEqual([]);
  });

  it("rejects generic response modes that xAI server VAD cannot disable", () => {
    const provider = buildXaiRealtimeVoiceProvider();
    const callbacks = { onAudio: vi.fn(), onClearAudio: vi.fn() };
    expect(() =>
      provider.createBridge({
        providerConfig: { apiKey: "xai-test" }, // pragma: allowlist secret
        autoRespondToAudio: false,
        ...callbacks,
      }),
    ).toThrow('use consultRouting: "provider-direct"');
    expect(() =>
      provider.createBridge({
        providerConfig: { apiKey: "xai-test" }, // pragma: allowlist secret
        interruptResponseOnInputAudio: false,
        ...callbacks,
      }),
    ).toThrow("requires automatic server-VAD interruption handling");
    expect(() =>
      provider.createBridge({
        providerConfig: {
          apiKey: "xai-test", // pragma: allowlist secret
          interruptResponseOnInputAudio: false,
        },
        ...callbacks,
      }),
    ).toThrow("requires automatic server-VAD interruption handling");
  });

  it("rejects reasoning efforts unsupported by the xAI Voice Agent API", () => {
    expect(() => createTestBridge({ providerConfig: { reasoningEffort: "low" } })).toThrow(
      'reasoningEffort must be "high" or "none"',
    );
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("forwards standard incremental input-transcription events", async () => {
    const onTranscript = vi.fn();
    const { socket } = await connect({ onTranscript });
    socket.emitServer({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "item_speech",
      delta: "open claw",
    });
    expect(onTranscript).toHaveBeenCalledWith("user", "open claw", false);
  });

  it("surfaces input transcription failures and discards their stale replacement text", async () => {
    const onTranscript = vi.fn();
    const onError = vi.fn();
    const onEvent = vi.fn();
    const { socket } = await connect({ onTranscript, onError, onEvent });
    socket.emitServer({
      type: "conversation.item.input_audio_transcription.updated",
      item_id: "item_speech",
      transcript: "stale speech",
    });
    socket.emitServer({
      type: "conversation.item.input_audio_transcription.failed",
      item_id: "item_speech",
      error: { code: "decoder_failure", message: "speech decoder exploded" },
    });
    socket.emitServer({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item_speech",
    });
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "speech decoder exploded" }),
    );
    expect(onTranscript).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledWith({
      direction: "server",
      type: "conversation.item.input_audio_transcription.failed",
      itemId: "item_speech",
      detail: "speech decoder exploded",
    });
  });

  it("preserves corrected final text from legacy realtime text events", async () => {
    const onTranscript = vi.fn();
    const { socket } = await connect({ onTranscript });
    socket.emitServer({ type: "response.created" });
    socket.emitServer({ type: "response.text.delta", delta: "draft assistant" });
    socket.emitServer({ type: "response.text.done", text: "corrected assistant" });
    socket.emitServer({ type: "response.done" });
    expect(onTranscript.mock.calls).toEqual([
      ["assistant", "draft assistant", false],
      ["assistant", "corrected assistant", true],
    ]);
  });

  it("continues after malformed terminal items and content beside valid text", async () => {
    const onTranscript = vi.fn();
    const { bridge, socket } = await connect({ onTranscript });
    socket.emitServer({ type: "response.created" });
    bridge.sendUserMessage?.("Continue.");
    socket.emitServer({
      type: "response.done",
      response: {
        status: "completed",
        output: [
          null,
          {
            type: "message",
            role: "assistant",
            content: [
              null,
              { type: "output_text", text: "Valid text " },
              { type: "output_audio", transcript: "and audio" },
            ],
          },
        ],
      },
    });
    expect(parseSent(socket).slice(-2)).toEqual([
      userMessageEvent("Continue."),
      { type: "response.create" },
    ]);
    expect(onTranscript.mock.calls).toEqual([["assistant", "Valid text and audio", true]]);
  });

  it.each([false, true])(
    "interrupts acknowledged legacy playback (completed=%s)",
    async (completed) => {
      const onAudio = vi.fn();
      const onClearAudio = vi.fn();
      const { bridge, socket } = await connect({
        audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
        onAudio,
        onClearAudio,
      });
      socket.emitServer({ type: "response.created", response: { id: "response" } });
      bridge.setMediaTimestamp(1000);
      audio(socket, "item", Buffer.alloc(14400).toString("base64"));
      bridge.acknowledgeMark?.();
      if (completed) {
        responseDone(socket, "response");
      }
      bridge.setMediaTimestamp(4760);
      if (completed) {
        bridge.handleBargeIn?.({ audioPlaybackActive: true });
      } else {
        socket.emitServer({ type: "input_audio_buffer.speech_started" });
      }
      expect(onAudio).toHaveBeenCalledOnce();
      expect(onClearAudio).toHaveBeenCalledExactlyOnceWith("barge-in");
      expect(
        parseSent(socket).filter(
          (event) =>
            event.type === "response.cancel" || event.type === "conversation.item.truncate",
        ),
      ).toEqual(
        completed
          ? [
              { type: "response.cancel" },
              {
                type: "conversation.item.truncate",
                item_id: "item",
                content_index: 0,
                audio_end_ms: 300,
              },
            ]
          : [],
      );
    },
  );

  it("terminates realtime voice on non-canonical base64 audio", async () => {
    const onAudio = vi.fn();
    const onClose = vi.fn();
    const onError = vi.fn();
    let retry: Promise<void> | undefined;
    const handleError = (error: Error) => {
      onError(error);
      retry = bridge.connect();
    };
    const { bridge, socket } = await connect({ onAudio, onClose, onError: handleError });
    socket.emitServer({ type: "response.output_audio.delta", delta: "ZE==" });
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "xAI realtime voice stream returned malformed base64 audio data",
      }),
    );
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onAudio).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith("error");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(socket.closed).toBe(true);
    if (!retry) {
      throw new Error("expected synchronous retry from onError");
    }
    await expect(retry).rejects.toThrow(
      "xAI realtime voice stream returned malformed base64 audio data",
    );
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("deduplicates repeated function-call arguments done events", async () => {
    const onToolCall = vi.fn();
    const { socket } = await connect({ onToolCall });
    socket.emitServer({
      type: "response.function_call_arguments.delta",
      item_id: "item_tool_1",
      name: "openclaw_agent_consult",
      call_id: "call_1",
      delta: JSON.stringify({ question: "delegate this" }),
    });
    socket.emitServer({
      type: "response.function_call_arguments.done",
      item_id: "item_tool_1",
      name: "openclaw_agent_consult",
      call_id: "call_1",
    });
    toolArguments(socket, "item_tool_1", "call_1", JSON.stringify({ question: "delegate this" }));
    responseDone(socket);
    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(onToolCall).toHaveBeenCalledWith({
      itemId: "item_tool_1",
      callId: "call_1",
      name: "openclaw_agent_consult",
      args: { question: "delegate this" },
    });
  });

  it("uses explicitly empty completed tool arguments instead of the streamed draft", async () => {
    const onToolCall = vi.fn();
    const { socket } = await connect({ onToolCall });
    socket.emitServer({
      type: "response.function_call_arguments.delta",
      item_id: "item_tool_1",
      call_id: "call_1",
      name: "lookup_weather",
      delta: '{"city":"draft"}',
    });
    toolArguments(socket, "item_tool_1", "call_1", "", "lookup_weather");
    responseDone(socket);
    expect(onToolCall).toHaveBeenCalledWith({
      itemId: "item_tool_1",
      callId: "call_1",
      name: "lookup_weather",
      args: {},
    });
  });

  it("rejects malformed and non-object arguments once and releases the next turn", async () => {
    const onEvent = vi.fn();
    const onToolCall = vi.fn();
    const { bridge, socket } = await connect({ onEvent, onToolCall });
    socket.emitServer({ type: "response.created" });
    const invalidEvents = ["{", "null"].map((arguments_, index) => ({
      type: "response.function_call_arguments.done",
      item_id: `item_${index}`,
      call_id: `call_${index}`,
      name: "lookup",
      arguments: arguments_,
    }));
    for (const event of invalidEvents) {
      socket.emitServer(event);
    }
    socket.emitServer(invalidEvents[0]);
    responseDone(socket);
    expect(onToolCall).not.toHaveBeenCalled();
    expect(
      onEvent.mock.calls
        .map(([event]) => event)
        .filter((event) => event.type === "tool_call.arguments.rejected"),
    ).toEqual([
      {
        direction: "server",
        type: "tool_call.arguments.rejected",
        detail: "reason=malformed-json",
        itemId: "item_0",
      },
      {
        direction: "server",
        type: "tool_call.arguments.rejected",
        detail: "reason=non-object-json",
        itemId: "item_1",
      },
    ]);
    expect(sent(socket, "conversation.item.create")).toEqual([
      toolResultEvent("call_0", { error: "Invalid tool arguments." }),
      toolResultEvent("call_1", { error: "Invalid tool arguments." }),
    ]);
    expect(sent(socket, "response.create")).toEqual([{ type: "response.create" }]);
    socket.emitServer({ type: "response.done" });
    expect(sent(socket, "response.create")).toEqual([{ type: "response.create" }]);
    socket.emitServer({ type: "response.created" });
    socket.emitServer({ type: "response.done" });
    bridge.sendUserMessage?.("Continue.");
    expect(parseSent(socket).slice(-2)).toEqual([
      userMessageEvent("Continue."),
      { type: "response.create" },
    ]);
  });

  it("rejects an undefined tool result before transport ownership changes", async () => {
    const onError = vi.fn();
    const { bridge, socket } = await connect({ onError, onToolCall: vi.fn() });
    toolArguments(socket, "item_call_1", "call_1");
    expect(() => bridge.submitToolResult("call_1", undefined)).toThrow(/serializ/i);
    expect(onError).not.toHaveBeenCalled();
    expect(sent(socket, "conversation.item.create")).toEqual([]);
    await bridge.submitToolResult("call_1", { recovered: true });
    expect(parseSent(socket).slice(-2)).toEqual([
      toolResultEvent("call_1", { recovered: true }),
      { type: "response.create" },
    ]);
  });

  it("serializes a tool result once while suppressing its response", async () => {
    const { bridge, socket } = await connect({ onToolCall: vi.fn() });
    const toJSON = vi.fn((key: string) => ({ key }));
    await bridge.submitToolResult("call", { toJSON }, { suppressResponse: true });
    expect(parseSent(socket).slice(1)).toEqual([toolResultEvent("call", { key: "" })]);
    expect(toJSON).toHaveBeenCalledExactlyOnceWith("");
  });

  it("rejects reconnect queue overflow without reporting successful delivery", async () => {
    const onError = vi.fn();
    const bridge = createTestBridge({ onError });

    for (let index = 0; index < 128; index += 1) {
      await bridge.submitToolResult(`call_${index}`, { ok: true });
    }

    expect(() => bridge.submitToolResult("overflow", { ok: true })).toThrow(
      "xAI realtime voice pending tool result queue overflow during reconnect",
    );
    expect(onError).toHaveBeenCalledOnce();
  });

  it("defers response.create for tool results until queued playback marks drain", async () => {
    const onMark = vi.fn();
    const { bridge, socket } = await connect({
      onToolCall: vi.fn(),
      onMark,
    });
    socket.emitServer({ type: "response.created" });
    audio(socket, "item_audio_1", Buffer.from("assistant audio").toString("base64"));
    responseDone(socket);
    toolArguments(socket, "item_call_1", "call_1", JSON.stringify({ question: "call_1" }));
    await bridge.submitToolResult("call_1", { text: "final" });
    expect(sent(socket, "response.create")).toEqual([]);
    const markName = onMark.mock.calls[0]?.[0];
    expect(markName).toMatch(/^audio-/);

    bridge.acknowledgeMark?.("stale-mark");
    expect(sent(socket, "response.create")).toEqual([]);
    const acknowledge = onMark.mock.calls[0]?.[1];
    expect(acknowledge).toBeTypeOf("function");
    acknowledge();
    acknowledge();
    expect(sent(socket, "response.create")).toEqual([{ type: "response.create" }]);
  });

  it("fails the session when playback marks exceed their ownership bound", async () => {
    const onAudio = vi.fn();
    const onClose = vi.fn();
    const onError = vi.fn();
    const onMark = vi.fn();
    const { bridge, socket } = await connect({ onAudio, onClose, onError, onMark });
    const delta = Buffer.from("assistant audio").toString("base64");
    socket.emitServer({ type: "response.created" });
    for (let index = 0; index < XAI_REALTIME_MAX_PENDING_PLAYBACK_MARKS; index += 1) {
      socket.emitServer({ type: "response.output_audio.delta", delta });
    }
    socket.emitServer({ type: "response.output_audio.delta", delta });
    expect(onAudio).toHaveBeenCalledTimes(XAI_REALTIME_MAX_PENDING_PLAYBACK_MARKS);
    expect(onMark).toHaveBeenCalledTimes(XAI_REALTIME_MAX_PENDING_PLAYBACK_MARKS);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: `xAI realtime voice playback mark limit exceeded (${XAI_REALTIME_MAX_PENDING_PLAYBACK_MARKS})`,
      }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith("error");
    expect(socket.closed).toBe(true);
    socket.emitServer({ type: "response.output_audio.delta", delta });
    await bridge.close();
    expect(onAudio).toHaveBeenCalledTimes(XAI_REALTIME_MAX_PENDING_PLAYBACK_MARKS);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    await expect(bridge.connect()).rejects.toThrow(
      `xAI realtime voice playback mark limit exceeded (${XAI_REALTIME_MAX_PENDING_PLAYBACK_MARKS})`,
    );
  });

  it("keeps failed realtime transport sends retryable across reconnect", async () => {
    vi.useFakeTimers();
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: ["xai", "test"].join("-") });
    const onEvent = vi.fn();
    const { bridge, socket: firstSocket } = await connect(
      {
        providerConfig: { sessionResumption: true },
        onEvent,
        onToolCall: vi.fn(),
      },
      "conv_failed_output",
    );
    toolArguments(firstSocket, "item_failed_output", "call_failed_output");
    const sendError = new Error("realtime transport rejected the output");
    vi.spyOn(firstSocket, "send").mockImplementationOnce(() => {
      throw sendError;
    });
    expect(() => bridge.submitToolResult("call_failed_output", { failed: true })).toThrow(
      sendError,
    );
    const resumedSocket = await reconnect(firstSocket);
    resumedSocket.open();
    resumedSocket.emitServer({ type: "session.updated" });
    await bridge.submitToolResult("call_failed_output", { recovered: true });
    expect(
      parseSent(resumedSocket).find((event) => event.type === "conversation.item.create"),
    ).toEqual(toolResultEvent("call_failed_output", { recovered: true }));
    expect(onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "session.reconnect.blocked" }),
    );
  });

  it("fails closed when a tool output was not acknowledged before reconnect", async () => {
    vi.useFakeTimers();
    const onToolCall = vi.fn();
    const onEvent = vi.fn();
    const onClose = vi.fn();
    const { bridge, socket: firstSocket } = await connect(
      { providerConfig: resumingConfig, onToolCall, onEvent, onClose },
      "conv_lost_output",
    );
    toolArguments(
      firstSocket,
      "item_lost_output",
      "call_lost_output",
      JSON.stringify({ question: "recover output" }),
    );
    responseDone(firstSocket);
    await bridge.submitToolResult("call_lost_output", { text: "recovered" });
    firstSocket.close(1006, "output acknowledgement lost");
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith({
      direction: "client",
      type: "session.reconnect.blocked",
      detail: "reason=websocket-close unacknowledgedToolResults=1",
    });
    expect(onClose).toHaveBeenCalledWith("error");
  });

  it("does not retry a tool output acknowledged by resumed item replay", async () => {
    vi.useFakeTimers();
    const onToolCall = vi.fn();
    const { bridge, socket: firstSocket } = await connect(
      { providerConfig: resumingConfig, onToolCall },
      "conv_saved_output",
    );
    toolArguments(
      firstSocket,
      "item_saved_output",
      "call_saved_output",
      JSON.stringify({ question: "saved output" }),
    );
    responseDone(firstSocket);
    await bridge.submitToolResult("call_saved_output", { text: "saved" });
    firstSocket.emitServer({
      type: "conversation.item.added",
      item: {
        id: "item_saved_result",
        type: "function_call_output",
        call_id: "call_saved_output",
        output: JSON.stringify({ text: "saved" }),
      },
    });
    const secondSocket = await reconnect(firstSocket);
    secondSocket.open();
    secondSocket.emitServer({ type: "session.updated" });
    for (const item of [
      {
        id: "item_saved_output",
        type: "function_call",
        call_id: "call_saved_output",
        name: "openclaw_agent_consult",
        arguments: JSON.stringify({ question: "saved output" }),
      },
      {
        id: "item_saved_result",
        type: "function_call_output",
        call_id: "call_saved_output",
        output: JSON.stringify({ text: "saved" }),
      },
    ]) {
      secondSocket.emitServer({ type: "conversation.item.created", item });
    }

    await vi.advanceTimersByTimeAsync(500);
    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(sent(secondSocket, "conversation.item.create")).toEqual([]);
  });

  it("queues tool results submitted while a resumed session is reconnecting", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const { bridge, socket: firstSocket } = await connect(
      {
        providerConfig: resumingConfig,
        onError,
        onToolCall: vi.fn(),
      },
      "conv_tool_queue",
    );

    for (const callId of ["call_1", "call_2"]) {
      toolArguments(firstSocket, `item_${callId}`, callId, JSON.stringify({ question: callId }));
    }
    responseDone(firstSocket);
    const secondSocket = await reconnect(firstSocket);
    expect(String(secondSocket.args[0])).toContain("conversation_id=conv_tool_queue");
    secondSocket.open();

    onError.mockClear();
    expect(() => bridge.submitToolResult("call_1", { invalid: 1n })).toThrow(/serializ/i);
    expect(onError).toHaveBeenCalledOnce();
    expect(() =>
      bridge.submitToolResult("call_1", undefined, { willContinue: true }),
    ).not.toThrow();
    expect(onError).toHaveBeenCalledOnce();
    await bridge.submitToolResult("call_1", { text: "first" });
    expect(sent(secondSocket, "conversation.item.create")).toEqual([]);
    secondSocket.emitServer({ type: "session.updated" });
    expect(sent(secondSocket, "response.create")).toEqual([]);
    expect(parseSent(secondSocket).slice(-1)).toEqual([
      toolResultEvent("call_1", { text: "first" }),
    ]);
    await bridge.submitToolResult("call_2", { text: "second" });
    expect(parseSent(secondSocket).slice(-2)).toEqual([
      toolResultEvent("call_2", { text: "second" }),
      { type: "response.create" },
    ]);
  });

  it("queues text turns submitted while a resumed session is reconnecting", async () => {
    vi.useFakeTimers();
    const onReady = vi.fn();
    const { bridge, socket: firstSocket } = await connect(
      { onReady, providerConfig: resumingConfig },
      "conv_text_queue",
    );
    expect(requireSession(firstSocket).resumption).toEqual({ enabled: true });
    const secondSocket = await reconnect(firstSocket);
    expect(String(secondSocket.args[0])).toContain("conversation_id=conv_text_queue");
    secondSocket.open();
    expect(requireSession(secondSocket).resumption).toEqual({ enabled: true });

    bridge.sendUserMessage?.("OpenClaw finished checking.");
    expect(sent(secondSocket, "conversation.item.create")).toEqual([]);
    secondSocket.emitServer({ type: "session.updated" });
    expect(parseSent(secondSocket).slice(-2)).toEqual([
      userMessageEvent("OpenClaw finished checking."),
      { type: "response.create" },
    ]);
    expect(onReady).toHaveBeenCalledOnce();
  });

  it("exhausts reconnect attempts when websocket opens without session setup", async () => {
    vi.useFakeTimers();
    const onEvent = vi.fn();
    const onClose = vi.fn();
    const { socket: firstSocket } = await connect(
      { providerConfig: resumingConfig, onEvent, onClose },
      "conv_reconnect",
    );
    firstSocket.close(1006, "connection lost");

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const delayMs = 1000 * 2 ** (attempt - 1);
      await vi.advanceTimersByTimeAsync(delayMs);
      await waitForRealtimeState(() => expect(FakeWebSocket.instances.length).toBe(attempt + 1));
      const socket = requireSocket(attempt);
      socket.open();
      socket.close(1006, "session setup failed");
    }

    await waitForRealtimeState(() =>
      expect(onEvent).toHaveBeenCalledWith({
        direction: "client",
        type: "session.reconnect.exhausted",
        detail: "reason=websocket-close attempts=5",
      }),
    );
    expect(onClose).toHaveBeenCalledWith("error");
  });

  it("cancels a pending reconnect and allows a later explicit connect", async () => {
    vi.useFakeTimers();
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: ["xai", "test"].join("-") });
    const onError = vi.fn();
    const { bridge, socket: firstSocket } = await connect(
      { providerConfig: { sessionResumption: true }, onError },
      "conv_close",
    );
    firstSocket.close(1006, "connection lost");
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);

    void bridge.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(onError).not.toHaveBeenCalled();
    const reconnecting = bridge.connect();
    await waitForRealtimeState(() => expect(FakeWebSocket.instances.length).toBe(2));
    const reconnectedSocket = requireSocket(1);
    expect(String(reconnectedSocket.args[0])).not.toContain("conversation_id=");
    reconnectedSocket.open();
    reconnectedSocket.emitServer({ type: "session.updated" });
    await reconnecting;
    expect(bridge.isConnected()).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(onError).not.toHaveBeenCalled();
  });

  it("fails closed instead of reconnecting without a conversation id", async () => {
    vi.useFakeTimers();
    const onEvent = vi.fn();
    const onClose = vi.fn();
    const { socket } = await connect({ providerConfig: resumingConfig, onEvent, onClose });
    socket.close(1006, "connection lost");
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(onEvent).toHaveBeenCalledWith({
      direction: "client",
      type: "session.reconnect.blocked",
      detail: "reason=websocket-close missingConversationId=true",
    });
    expect(onClose).toHaveBeenCalledWith("error");
  });

  it("fails closed instead of reconnecting when xAI session resumption is disabled", async () => {
    vi.useFakeTimers();
    const onEvent = vi.fn();
    const onClose = vi.fn();
    const { socket } = await connect({ onEvent, onClose }, "conv_default");
    socket.close(1006, "connection lost");
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(onEvent).toHaveBeenCalledWith({
      direction: "client",
      type: "session.reconnect.blocked",
      detail: "reason=websocket-close sessionResumption=false",
    });
    expect(onClose).toHaveBeenCalledWith("error");
  });

  it("does not retry after startup websocket errors", async () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const bridge = createTestBridge({ onClose });
    const connecting = bridge.connect();
    await waitForRealtimeState(() => expect(FakeWebSocket.instances.length).toBe(1));
    const socket = requireSocket();
    socket.open();
    socket.emit("error", new Error("bad auth"));

    await expect(connecting).rejects.toThrow("bad auth");
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("preserves successor audio and tools after an interrupted response's late terminal", async () => {
    const onAudio = vi.fn();
    const onToolCall = vi.fn();
    const onResponseDone = vi.fn();
    const { bridge, socket } = await connect({ onAudio, onToolCall, onResponseDone });
    socket.emitServer({ type: "response.created", response: { id: "interrupted" } });
    toolArguments(
      socket,
      "item_interrupted",
      "call_interrupted",
      '{"city":"Paris"}',
      "lookup_weather",
    );
    bridge.handleBargeIn?.();
    socket.emitServer({ type: "response.created", response: { id: "successor" } });
    responseDone(socket, "interrupted", "cancelled");
    expect(onResponseDone).not.toHaveBeenCalled();
    expect(onToolCall).not.toHaveBeenCalled();
    socket.emitServer({
      type: "response.output_audio.delta",
      response_id: "successor",
      delta: "AAA=",
    });
    expect(onAudio).toHaveBeenCalledOnce();
    toolArguments(socket, "item_successor", "call_successor", '{"city":"Tokyo"}', "lookup_weather");
    responseDone(socket, "successor");
    expect(onToolCall).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ callId: "call_successor", args: { city: "Tokyo" } }),
    );
    expect(onResponseDone).toHaveBeenCalledExactlyOnceWith({
      responseId: "successor",
      status: "completed",
    });
  });

  it("ignores a late cancellation error after a successor response starts", async () => {
    const { bridge, socket } = await connect({});
    socket.emitServer({ type: "response.created", response: { id: "interrupted" } });
    bridge.handleBargeIn?.();
    socket.emitServer({ type: "response.created", response: { id: "successor" } });
    bridge.sendUserMessage?.("queued while successor is active");
    const responseCreatesBeforeError = parseSent(socket).filter(
      (event) => event.type === "response.create",
    ).length;
    socket.emitServer({
      type: "error",
      error: { message: "Cancellation failed: no active response found" },
    });
    expect(sent(socket, "response.create")).toHaveLength(responseCreatesBeforeError);
    responseDone(socket, "successor");
  });

  it("fences unkeyed retired output and preserves the next consult response", async () => {
    const onAudio = vi.fn();
    const onTranscript = vi.fn();
    const onResponseDone = vi.fn();
    const onToolCall = vi.fn();
    const onEvent = vi.fn();
    const { socket } = await connect({
      onAudio,
      onTranscript,
      onResponseDone,
      onToolCall,
      onEvent,
    });
    socket.emitServer({ type: "response.created", response: { id: "consult" } });
    responseDone(socket, "consult");
    onEvent.mockClear();
    socket.emitServer({
      type: "response.output_audio.delta",
      delta: "AAA=",
    });
    socket.emitServer({
      type: "response.output_audio_transcript.done",
      transcript: "late",
    });
    expect(onAudio).not.toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
    socket.emitServer({ type: "response.created", response: { id: "continuation" } });
    socket.emitServer({
      type: "response.output_audio_transcript.delta",
      response_id: "continuation",
      delta: "current",
    });
    socket.emitServer({
      type: "response.done",
      response: {
        id: "consult",
        status: "completed",
        output: [
          {
            id: "stale-tool",
            type: "function_call",
            call_id: "stale-call",
            name: "lookup",
            arguments: "{}",
          },
        ],
      },
    });
    expect(onToolCall).not.toHaveBeenCalled();
    expect(onResponseDone).toHaveBeenCalledTimes(1);
    expect(onTranscript.mock.calls).toEqual([["assistant", "current", false]]);
    responseDone(socket, "continuation");
    expect(onTranscript.mock.calls).toEqual([
      ["assistant", "current", false],
      ["assistant", "current", true],
    ]);
    expect(onResponseDone).toHaveBeenCalledTimes(2);
  });

  it("previews snapshots immediately and retains corrections after audio starts", async () => {
    const { socket, onTranscript } = await openTranscriptBridge();
    socket.emitServer({ type: "input_audio_buffer.speech_started" });
    socket.emitServer({ type: "response.created", response: { id: "response-1" } });
    inputTranscript(socket, "How");
    expect(onTranscript).toHaveBeenLastCalledWith("user", "How", false, { textMode: "snapshot" });
    socket.emitServer({ type: "response.output_audio.delta", delta: "AAA=" });
    inputTranscript(socket, "How big is Earth?");
    responseDone(socket, "response-1");
    inputTranscript(socket, "How big is Earth?");
    expect(onTranscript.mock.calls.filter((call) => call[2])).toEqual([
      ["user", "How big is Earth?", true, { textMode: "snapshot" }],
    ]);
  });

  it("preserves distinct late input items and repeated words in separate utterances", async () => {
    const { socket, onTranscript } = await openTranscriptBridge();
    socket.emitServer({ type: "input_audio_buffer.speech_started" });
    inputTranscript(socket, "Again", "late-A");
    inputTranscript(socket, "Again", "B");
    socket.emitServer({ type: "response.created", response: { id: "response-B" } });
    responseDone(socket, "response-B");
    expect(onTranscript.mock.calls.filter((call) => call[2])).toEqual([
      ["user", "Again", true, { textMode: "snapshot" }],
      ["user", "Again", true, { textMode: "snapshot" }],
    ]);
  });

  it("preserves pending spoken input when the response fails without duplicating it on close", async () => {
    const onTranscript = vi.fn();
    const { bridge, socket } = await connect({ onTranscript });
    inputTranscript(socket, "Check the sensor");
    socket.emitServer({ type: "response.created", response: { id: "response-1" } });
    responseDone(socket, "response-1", "failed");
    expect(onTranscript.mock.calls.filter((call) => call[2])).toEqual([
      ["user", "Check the sensor", true, { textMode: "snapshot" }],
    ]);
    await bridge.close();
    expect(onTranscript.mock.calls.filter((call) => call[2])).toHaveLength(1);
  });

  it("keeps a pending snapshot when a different input item fails transcription", async () => {
    const onError = vi.fn();
    const onTranscript = vi.fn();
    const { socket } = await connect({ onError, onTranscript });
    socket.emitServer({ type: "input_audio_buffer.speech_started" });
    socket.emitServer({ type: "response.created", response: { id: "one" } });
    inputTranscript(socket, "Read the gauge", "b");
    socket.emitServer({
      type: "conversation.item.input_audio_transcription.failed",
      item_id: "a",
      error: { message: "recognition failed" },
    });
    expect(onError).toHaveBeenCalledOnce();
    responseDone(socket, "one");
    expect(onTranscript.mock.calls.filter((call) => call[2])).toEqual([
      ["user", "Read the gauge", true, { textMode: "snapshot" }],
    ]);
  });

  it("settles input recognized after the response finished once it stops changing", async () => {
    const { socket, onTranscript } = await openTranscriptBridge();
    socket.emitServer({ type: "input_audio_buffer.speech_started" });
    socket.emitServer({ type: "response.created", response: { id: "one" } });
    responseDone(socket, "one");
    vi.useFakeTimers();
    inputTranscript(socket, "Check the", "u1");
    vi.advanceTimersByTime(1_000);
    inputTranscript(socket, "Check the sensor", "u1");
    vi.advanceTimersByTime(1_000);
    expect(onTranscript.mock.calls.filter((call) => call[2])).toEqual([]);
    vi.advanceTimersByTime(500);
    expect(onTranscript.mock.calls.filter((call) => call[2])).toEqual([
      ["user", "Check the sensor", true, { textMode: "snapshot" }],
    ]);
    vi.useRealTimers();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
