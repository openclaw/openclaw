import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ } from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { XAI_REALTIME_MAX_PENDING_PLAYBACK_MARKS } from "./realtime-voice-config.js";
import { buildXaiRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const { FakeWebSocket, isProviderAuthProfileConfiguredAsyncMock, resolveApiKeyForProviderMock } =
  await vi.hoisted(() => import("./realtime-voice-socket.test-support.js"));

vi.mock("./ws-runtime.js", () => ({
  WebSocket: FakeWebSocket,
}));

// mock-isolation: Realtime tests control credential availability and pending resolution without host auth storage.
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

function server(socket: FakeWebSocketInstance, type: string, data: object = {}) {
  socket.emitServer({ type, ...data });
}

function responseCreated(socket: FakeWebSocketInstance, id?: string) {
  server(socket, "response.created", id ? { response: { id } } : {});
}

function ready(socket: FakeWebSocketInstance) {
  socket.open();
  server(socket, "session.updated");
}

function transcript(socket: FakeWebSocketInstance, event: string, data: object) {
  server(socket, `conversation.item.input_audio_transcription.${event}`, data);
}

function finalTranscripts(onTranscript: ReturnType<typeof vi.fn>) {
  return onTranscript.mock.calls.filter((call) => call[2]);
}

function snapshot(text: string) {
  return ["user", text, true, { textMode: "snapshot" }];
}

function observers() {
  return {
    onAudio: vi.fn(),
    onClose: vi.fn(),
    onError: vi.fn(),
    onReady: vi.fn(),
    onTranscript: vi.fn(),
    onEvent: vi.fn(),
    onToolCall: vi.fn(),
    onResponseDone: vi.fn(),
  };
}

function expectError(onError: ReturnType<typeof vi.fn>, message: string) {
  expect(onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message }));
}

function toolItem(callId: string, args = "{}", name = "openclaw_agent_consult") {
  return { type: "function_call", call_id: callId, name, arguments: args };
}

async function connect(options: Partial<TestBridgeOptions> = {}, conversationId?: string) {
  const bridge = createTestBridge(options);
  const socket = await openRealtimeBridge(bridge, FakeWebSocket.instances.length, conversationId);
  return { bridge, socket };
}

async function observe(...names: (keyof ReturnType<typeof observers>)[]) {
  const callbacks = observers();
  const selected: Partial<TestBridgeOptions> = {};
  for (const name of names) {
    selected[name] = callbacks[name];
  }
  return { ...callbacks, ...(await connect(selected)) };
}

async function pendingConnection(bridge: ReturnType<typeof createTestBridge>, index = 0) {
  const connecting = bridge.connect();
  await waitForRealtimeState(() => expect(FakeWebSocket.instances).toHaveLength(index + 1));
  return { connecting, socket: requireSocket(index) };
}

async function resumable(
  options: Partial<TestBridgeOptions> = {},
  conversationId = "conversation",
) {
  vi.useFakeTimers();
  return connect({ providerConfig: resumingConfig, ...options }, conversationId);
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
  server(socket, "response.output_audio.delta", { item_id: itemId, delta });
}

function inputTranscript(socket: FakeWebSocketInstance, text: string, itemId?: string) {
  server(socket, "conversation.item.input_audio_transcription.completed", {
    item_id: itemId,
    transcript: text,
  });
}

function responseDone(socket: FakeWebSocketInstance, id?: string, status = "completed") {
  server(socket, "response.done", { response: { id, status } });
}

function toolArguments(
  socket: FakeWebSocketInstance,
  itemId: string,
  callId: string,
  args = "{}",
  name = "openclaw_agent_consult",
) {
  server(socket, "response.function_call_arguments.done", {
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

function truncateEvent(item_id: string, audio_end_ms: number) {
  return { type: "conversation.item.truncate", item_id, content_index: 0, audio_end_ms };
}

function expectTail(socket: FakeWebSocketInstance, ...events: unknown[]) {
  expect(parseSent(socket).slice(-events.length)).toEqual(events);
}

describe("buildXaiRealtimeVoiceProvider", () => {
  it("retires unheard playback marks after a failed native terminal", async () => {
    const onMark = vi.fn();
    const { bridge, socket } = await connect({ onMark });
    responseCreated(socket);
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
        responseCreated(socket, "native");
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
      responseCreated(socket, "native");
      const sentCount = socket.sent.length;
      expect(() => bridge.handleBargeIn?.({ force: true })).not.toThrow();
      expect(socket.closed).toBe(true);
      expect(socket.sent).toHaveLength(sentCount + 1);
      expect(parseSent(socket).at(-1)?.type).toBe("response.cancel");
    });

    it("truncates sink-owned playback items at their reported offsets", async () => {
      let playback = [
        { itemId: "audible", audioEndMs: 620 },
        { itemId: "queued", audioEndMs: 0 },
      ];
      const onClearAudio = vi.fn(() => {
        playback = [];
      });
      const bridge = createTestBridge({ getPlaybackState: () => playback, onClearAudio });
      const socket = await openRealtimeBridge(bridge);
      responseCreated(socket, "native");
      bridge.handleBargeIn?.({ force: true });
      expect(sent(socket, "response.cancel")).toHaveLength(1);
      expect(sent(socket, "conversation.item.truncate")).toEqual([
        truncateEvent("audible", 620),
        truncateEvent("queued", 0),
      ]);
      expect(onClearAudio).toHaveBeenCalledOnce();
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
    const { socket } = await connect({ cfg, agentId: "molty", providerConfig: {} });
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
    const credentials = createDeferred<{ apiKey: string | undefined }>();
    resolveApiKeyForProviderMock.mockReturnValue(credentials.promise);
    const bridge = createTestBridge({ cfg: {}, providerConfig: {} });
    const connecting = bridge.connect();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeWebSocket.instances).toHaveLength(0);
    credentials.resolve({ apiKey: "xai-oauth" });
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
    const credentials = createDeferred<{ apiKey: string | undefined }>();
    resolveApiKeyForProviderMock
      .mockReturnValueOnce(credentials.promise)
      .mockResolvedValue({ apiKey: "xai-replacement" }); // pragma: allowlist secret
    const bridge = createTestBridge({ cfg: {}, onClose, providerConfig: {} });
    const canceledConnect = bridge.connect();
    await waitForRealtimeState(() => expect(resolveApiKeyForProviderMock).toHaveBeenCalledOnce());
    void bridge.close();
    void bridge.close();
    const { connecting: replacementConnect, socket: replacementSocket } =
      await pendingConnection(bridge);
    ready(replacementSocket);
    await Promise.all([canceledConnect, replacementConnect]);
    expect(bridge.isConnected()).toBe(true);
    expect(onClose).toHaveBeenCalledExactlyOnceWith("completed");
    credentials.resolve({ apiKey: "xai-late" }); // pragma: allowlist secret
    await waitForRealtimeState(() => expect(FakeWebSocket.instances).toHaveLength(1));
  });

  it("rejects session readiness after its event callback closes the bridge", async () => {
    const { onClose, onReady } = observers();
    const bridge = createTestBridge({
      onClose,
      onReady,
      onEvent: (event) => {
        if (event.direction === "server" && event.type === "session.updated") {
          void bridge.close();
        }
      },
    });
    const { connecting, socket } = await pendingConnection(bridge);
    ready(socket);
    await connecting;
    expect(bridge.isConnected()).toBe(false);
    expect(onReady).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledExactlyOnceWith("completed");
  });

  it("uses XAI_API_KEY for default Grok realtime bridges", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-env"); // pragma: allowlist secret
    const { socket } = await connect({
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
    expect(socket.args[0]).toContain("wss://api.x.ai/v1/realtime?model=grok-voice-latest");
    expect(socket.args[1]).toMatchObject({
      headers: { Authorization: "Bearer xai-env" },
      maxPayload: 16 * 1024 * 1024,
    });
    const session = requireSession(socket);
    expect(session).toMatchObject({
      voice: "ara",
      reasoning: { effort: "none" },
      tool_choice: "auto",
    });
    expect(session.resumption).toBeUndefined();
    expect(session.tools).toHaveLength(1);
    expect({ turn: session.turn_detection, audio: session.audio }).toEqual({
      turn: {
        type: "server_vad",
        threshold: 0.9,
        prefix_padding_ms: 0,
        silence_duration_ms: 10000,
      },
      audio: {
        input: { format: { type: "audio/pcmu" }, transcription: { model: "grok-transcribe" } },
        output: { format: { type: "audio/pcmu" } },
      },
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
    const inputEvents = new Set([
      "input_audio_buffer.append",
      "conversation.item.create",
      "response.create",
    ]);
    expect(parseSent(socket).filter((event) => inputEvents.has(event.type))).toEqual([]);
  });

  it.each<[string, Partial<TestBridgeOptions>, string]>([
    [
      "manual audio response",
      { autoRespondToAudio: false },
      'use consultRouting: "provider-direct"',
    ],
    [
      "disabled request interruption",
      { interruptResponseOnInputAudio: false },
      "requires automatic server-VAD interruption handling",
    ],
    [
      "disabled provider interruption",
      { providerConfig: { apiKey: "xai-test", interruptResponseOnInputAudio: false } },
      "requires automatic server-VAD interruption handling",
    ], // pragma: allowlist secret
    [
      "unsupported reasoning effort",
      { providerConfig: { reasoningEffort: "low" } },
      'reasoningEffort must be "high" or "none"',
    ],
  ])("rejects %s", (_name, options, error) => {
    expect(() => createTestBridge(options)).toThrow(error);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("forwards standard incremental input-transcription events", async () => {
    const { socket, onTranscript } = await observe("onTranscript");
    transcript(socket, "delta", { item_id: "item_speech", delta: "open claw" });
    expect(onTranscript).toHaveBeenCalledWith("user", "open claw", false);
  });

  it("surfaces input transcription failures and discards their stale replacement text", async () => {
    const { socket, onTranscript, onError, onEvent } = await observe(
      "onTranscript",
      "onError",
      "onEvent",
    );
    transcript(socket, "updated", { item_id: "item_speech", transcript: "stale speech" });
    transcript(socket, "failed", {
      item_id: "item_speech",
      error: { code: "decoder_failure", message: "speech decoder exploded" },
    });
    transcript(socket, "completed", { item_id: "item_speech" });
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
      responseCreated(socket, "response");
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
        server(socket, "input_audio_buffer.speech_started");
      }
      expect(onAudio).toHaveBeenCalledOnce();
      expect(onClearAudio).toHaveBeenCalledExactlyOnceWith("barge-in");
      expect(
        parseSent(socket).filter(
          (event) =>
            event.type === "response.cancel" || event.type === "conversation.item.truncate",
        ),
      ).toEqual(completed ? [{ type: "response.cancel" }, truncateEvent("item", 300)] : []);
    },
  );

  it("terminates realtime voice on non-canonical base64 audio", async () => {
    const { onAudio, onClose, onError } = observers();
    let retry: Promise<void> | undefined;
    const handleError = (error: Error) => {
      onError(error);
      retry = bridge.connect();
    };
    const { bridge, socket } = await connect({ onAudio, onClose, onError: handleError });
    audio(socket, undefined, "ZE==");
    const message = "xAI realtime voice stream returned malformed base64 audio data";
    expectError(onError, message);
    expect(onAudio).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledExactlyOnceWith("error");
    expect(socket.closed).toBe(true);
    if (!retry) {
      throw new Error("expected synchronous retry from onError");
    }
    await expect(retry).rejects.toThrow(message);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it.each([
    [
      "streamed fallback and duplicate completion",
      undefined,
      "openclaw_agent_consult",
      { question: "delegate this" },
    ],
    ["explicit empty completion overriding the draft", "", "lookup_weather", {}],
  ] as const)("uses %s for tool arguments", async (_name, completed, toolName, args) => {
    const streamed = completed === undefined ? JSON.stringify(args) : '{"city":"draft"}';
    const { socket, onToolCall } = await observe("onToolCall");
    server(socket, "response.function_call_arguments.delta", {
      item_id: "item_tool_1",
      call_id: "call_1",
      name: toolName,
      delta: streamed,
    });
    server(socket, "response.function_call_arguments.done", {
      item_id: "item_tool_1",
      call_id: "call_1",
      name: toolName,
      ...(completed === undefined ? {} : { arguments: completed }),
    });
    if (completed === undefined) {
      toolArguments(socket, "item_tool_1", "call_1", streamed, toolName);
    }
    expect(onToolCall).not.toHaveBeenCalled();
    responseDone(socket);
    expect(onToolCall).toHaveBeenCalledExactlyOnceWith({
      itemId: "item_tool_1",
      callId: "call_1",
      name: toolName,
      args,
    });
  });

  it("rejects malformed and non-object arguments once and releases the next turn", async () => {
    const { bridge, socket, onEvent, onToolCall } = await observe("onEvent", "onToolCall");
    responseCreated(socket);
    const invalid = ["{", "null"] as const;
    for (const index of [0, 1, 0] as const) {
      toolArguments(socket, `item_${index}`, `call_${index}`, invalid[index], "lookup");
    }
    responseDone(socket);
    expect(onToolCall).not.toHaveBeenCalled();
    expect(
      onEvent.mock.calls
        .map(([event]) => event)
        .filter((event) => event.type === "tool_call.arguments.rejected")
        .map(({ detail, itemId }) => ({ detail, itemId })),
    ).toEqual([
      { detail: "reason=malformed-json", itemId: "item_0" },
      { detail: "reason=non-object-json", itemId: "item_1" },
    ]);
    expect(sent(socket, "conversation.item.create")).toEqual([
      toolResultEvent("call_0", { error: "Invalid tool arguments." }),
      toolResultEvent("call_1", { error: "Invalid tool arguments." }),
    ]);
    expect(sent(socket, "response.create")).toEqual([{ type: "response.create" }]);
    server(socket, "response.done");
    expect(sent(socket, "response.create")).toEqual([{ type: "response.create" }]);
    responseCreated(socket);
    server(socket, "response.done");
    bridge.sendUserMessage?.("Continue.");
    expectTail(socket, userMessageEvent("Continue."), { type: "response.create" });
  });

  it("rejects an undefined tool result before transport ownership changes", async () => {
    const { bridge, socket, onError } = await observe("onError", "onToolCall");
    toolArguments(socket, "item_call_1", "call_1");
    expect(() => bridge.submitToolResult("call_1", undefined)).toThrow(/serializ/i);
    expect(onError).not.toHaveBeenCalled();
    expect(sent(socket, "conversation.item.create")).toEqual([]);
    await bridge.submitToolResult("call_1", { recovered: true });
    expectTail(socket, toolResultEvent("call_1", { recovered: true }), { type: "response.create" });
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
    const { bridge, socket } = await connect({ onToolCall: vi.fn(), onMark });
    responseCreated(socket);
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
    const onMark = vi.fn();
    const { onAudio, onClose, onError } = observers();
    const { bridge, socket } = await connect({ onAudio, onClose, onError, onMark });
    const delta = Buffer.from("assistant audio").toString("base64");
    responseCreated(socket);
    for (let index = 0; index < XAI_REALTIME_MAX_PENDING_PLAYBACK_MARKS; index += 1) {
      audio(socket, undefined, delta);
    }
    audio(socket, undefined, delta);
    expect(onAudio).toHaveBeenCalledTimes(XAI_REALTIME_MAX_PENDING_PLAYBACK_MARKS);
    expect(onMark).toHaveBeenCalledTimes(XAI_REALTIME_MAX_PENDING_PLAYBACK_MARKS);
    const message = `xAI realtime voice playback mark limit exceeded (${XAI_REALTIME_MAX_PENDING_PLAYBACK_MARKS})`;
    expectError(onError, message);
    expect(onClose).toHaveBeenCalledExactlyOnceWith("error");
    expect(socket.closed).toBe(true);
    audio(socket, undefined, delta);
    await bridge.close();
    expect(onAudio).toHaveBeenCalledTimes(XAI_REALTIME_MAX_PENDING_PLAYBACK_MARKS);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    await expect(bridge.connect()).rejects.toThrow(message);
  });

  it("keeps failed realtime transport sends retryable across reconnect", async () => {
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: ["xai", "test"].join("-") });
    const onEvent = vi.fn();
    const { bridge, socket: firstSocket } = await resumable({
      providerConfig: { sessionResumption: true },
      onEvent,
      onToolCall: vi.fn(),
    });
    toolArguments(firstSocket, "item", "call");
    const sendError = new Error("realtime transport rejected the output");
    vi.spyOn(firstSocket, "send").mockImplementationOnce(() => {
      throw sendError;
    });
    expect(() => bridge.submitToolResult("call", { failed: true })).toThrow(sendError);
    const resumedSocket = await reconnect(firstSocket);
    ready(resumedSocket);
    await bridge.submitToolResult("call", { recovered: true });
    expect(
      parseSent(resumedSocket).find((event) => event.type === "conversation.item.create"),
    ).toEqual(toolResultEvent("call", { recovered: true }));
    expect(onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "session.reconnect.blocked" }),
    );
  });

  it("fails closed when a tool output was not acknowledged before reconnect", async () => {
    const { onToolCall, onEvent, onClose } = observers();
    const { bridge, socket: firstSocket } = await resumable({ onToolCall, onEvent, onClose });
    toolArguments(firstSocket, "item", "call", '{"question":"recover"}');
    responseDone(firstSocket);
    await bridge.submitToolResult("call", { text: "recovered" });
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
    const onToolCall = vi.fn();
    const { bridge, socket: firstSocket } = await resumable({ onToolCall });
    const args = '{"question":"saved"}';
    const output = {
      id: "result",
      ...toolResultEvent("call", { text: "saved" }).item,
    };
    toolArguments(firstSocket, "item", "call", args);
    responseDone(firstSocket);
    await bridge.submitToolResult("call", { text: "saved" });
    server(firstSocket, "conversation.item.added", { item: output });
    const secondSocket = await reconnect(firstSocket);
    ready(secondSocket);
    for (const item of [{ id: "item", ...toolItem("call", args) }, output]) {
      server(secondSocket, "conversation.item.created", { item });
    }

    await vi.advanceTimersByTimeAsync(500);
    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(sent(secondSocket, "conversation.item.create")).toEqual([]);
  });

  it("queues tool results submitted while a resumed session is reconnecting", async () => {
    const onError = vi.fn();
    const { bridge, socket: firstSocket } = await resumable(
      { onError, onToolCall: vi.fn() },
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
    server(secondSocket, "session.updated");
    expect(sent(secondSocket, "response.create")).toEqual([]);
    expectTail(secondSocket, toolResultEvent("call_1", { text: "first" }));
    await bridge.submitToolResult("call_2", { text: "second" });
    expectTail(secondSocket, toolResultEvent("call_2", { text: "second" }), {
      type: "response.create",
    });
  });

  it("queues text turns submitted while a resumed session is reconnecting", async () => {
    const onReady = vi.fn();
    const { bridge, socket: firstSocket } = await resumable({ onReady }, "conv_text_queue");
    expect(requireSession(firstSocket).resumption).toEqual({ enabled: true });
    const secondSocket = await reconnect(firstSocket);
    expect(String(secondSocket.args[0])).toContain("conversation_id=conv_text_queue");
    secondSocket.open();
    expect(requireSession(secondSocket).resumption).toEqual({ enabled: true });

    bridge.sendUserMessage?.("OpenClaw finished checking.");
    expect(sent(secondSocket, "conversation.item.create")).toEqual([]);
    server(secondSocket, "session.updated");
    expectTail(secondSocket, userMessageEvent("OpenClaw finished checking."), {
      type: "response.create",
    });
    expect(onReady).toHaveBeenCalledOnce();
  });

  it("cancels a pending reconnect and allows a later explicit connect", async () => {
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: ["xai", "test"].join("-") });
    const onError = vi.fn();
    const { bridge, socket: firstSocket } = await resumable({
      providerConfig: { sessionResumption: true },
      onError,
    });
    firstSocket.close(1006, "connection lost");
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);

    void bridge.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(onError).not.toHaveBeenCalled();
    const { connecting: reconnecting, socket: reconnectedSocket } = await pendingConnection(
      bridge,
      1,
    );
    expect(String(reconnectedSocket.args[0])).not.toContain("conversation_id=");
    ready(reconnectedSocket);
    await reconnecting;
    expect(bridge.isConnected()).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(onError).not.toHaveBeenCalled();
  });

  it.each([
    [resumingConfig, undefined, "missingConversationId=true"],
    [undefined, "conv_default", "sessionResumption=false"],
  ] as const)(
    "fails closed instead of reconnecting (%j, %s, %s)",
    async (providerConfig, conversationId, reason) => {
      vi.useFakeTimers();
      const { onEvent, onClose } = observers();
      const { socket } = await connect(
        { ...(providerConfig ? { providerConfig } : {}), onEvent, onClose },
        conversationId,
      );
      socket.close(1006, "connection lost");
      await vi.advanceTimersByTimeAsync(1000);
      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(onEvent).toHaveBeenCalledWith({
        direction: "client",
        type: "session.reconnect.blocked",
        detail: `reason=websocket-close ${reason}`,
      });
      expect(onClose).toHaveBeenCalledWith("error");
    },
  );

  it("preserves successor audio and tools after an interrupted response's late terminal", async () => {
    const { bridge, socket, onAudio, onToolCall, onResponseDone } = await observe(
      "onAudio",
      "onToolCall",
      "onResponseDone",
    );
    responseCreated(socket, "interrupted");
    toolArguments(socket, "old-item", "old-call", '{"city":"Paris"}', "weather");
    bridge.handleBargeIn?.();
    responseCreated(socket, "successor");
    bridge.sendUserMessage?.("queued while successor is active");
    const createsBeforeError = sent(socket, "response.create").length;
    server(socket, "error", {
      error: { message: "Cancellation failed: no active response found" },
    });
    expect(sent(socket, "response.create")).toHaveLength(createsBeforeError);
    responseDone(socket, "interrupted", "cancelled");
    expect(onResponseDone).not.toHaveBeenCalled();
    expect(onToolCall).not.toHaveBeenCalled();
    server(socket, "response.output_audio.delta", { response_id: "successor", delta: "AAA=" });
    expect(onAudio).toHaveBeenCalledOnce();
    toolArguments(socket, "new-item", "new-call", '{"city":"Tokyo"}', "weather");
    responseDone(socket, "successor");
    expect(onToolCall).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ callId: "new-call", args: { city: "Tokyo" } }),
    );
    expect(onResponseDone).toHaveBeenCalledExactlyOnceWith({
      responseId: "successor",
      status: "completed",
    });
  });

  it("fences unkeyed retired output and preserves the next consult response", async () => {
    const { socket, onAudio, onTranscript, onResponseDone, onToolCall, onEvent } = await observe(
      "onAudio",
      "onTranscript",
      "onResponseDone",
      "onToolCall",
      "onEvent",
    );
    responseCreated(socket, "consult");
    server(socket, "response.text.delta", { delta: "draft assistant" });
    server(socket, "response.text.done", { text: "corrected assistant" });
    expect(onTranscript.mock.calls).toEqual([
      ["assistant", "draft assistant", false],
      ["assistant", "corrected assistant", true],
    ]);
    onTranscript.mockClear();
    responseDone(socket, "consult");
    onEvent.mockClear();
    audio(socket, undefined, "AAA=");
    server(socket, "response.output_audio_transcript.done", { transcript: "late" });
    expect(onAudio).not.toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
    responseCreated(socket, "continuation");
    server(socket, "response.output_audio_transcript.delta", {
      response_id: "continuation",
      delta: "current",
    });
    server(socket, "response.done", {
      response: {
        id: "consult",
        status: "completed",
        output: [{ id: "stale-tool", ...toolItem("stale-call", "{}", "lookup") }],
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
    const { socket, onTranscript } = await observe("onTranscript");
    server(socket, "input_audio_buffer.speech_started");
    responseCreated(socket, "response-1");
    inputTranscript(socket, "How");
    expect(onTranscript).toHaveBeenLastCalledWith("user", "How", false, { textMode: "snapshot" });
    audio(socket, undefined, "AAA=");
    inputTranscript(socket, "How big is Earth?");
    responseDone(socket, "response-1");
    inputTranscript(socket, "How big is Earth?");
    expect(finalTranscripts(onTranscript)).toEqual([snapshot("How big is Earth?")]);
  });

  it("preserves distinct late input items and repeated words in separate utterances", async () => {
    const { socket, onTranscript } = await observe("onTranscript");
    server(socket, "input_audio_buffer.speech_started");
    inputTranscript(socket, "Again", "late-A");
    inputTranscript(socket, "Again", "B");
    responseCreated(socket, "response-B");
    responseDone(socket, "response-B");
    expect(finalTranscripts(onTranscript)).toEqual([snapshot("Again"), snapshot("Again")]);
  });

  it("preserves pending spoken input when the response fails without duplicating it on close", async () => {
    const { bridge, socket, onTranscript } = await observe("onTranscript");
    inputTranscript(socket, "Check the sensor");
    responseCreated(socket, "response-1");
    responseDone(socket, "response-1", "failed");
    expect(finalTranscripts(onTranscript)).toEqual([snapshot("Check the sensor")]);
    await bridge.close();
    expect(finalTranscripts(onTranscript)).toHaveLength(1);
  });

  it("keeps a pending snapshot when a different input item fails transcription", async () => {
    const { socket, onError, onTranscript } = await observe("onError", "onTranscript");
    server(socket, "input_audio_buffer.speech_started");
    responseCreated(socket, "one");
    inputTranscript(socket, "Read the gauge", "b");
    transcript(socket, "failed", {
      item_id: "a",
      error: { message: "recognition failed" },
    });
    expect(onError).toHaveBeenCalledOnce();
    responseDone(socket, "one");
    expect(finalTranscripts(onTranscript)).toEqual([snapshot("Read the gauge")]);
  });

  it("settles input recognized after the response finished once it stops changing", async () => {
    const { socket, onTranscript } = await observe("onTranscript");
    server(socket, "input_audio_buffer.speech_started");
    responseCreated(socket, "one");
    responseDone(socket, "one");
    vi.useFakeTimers();
    inputTranscript(socket, "Check the", "u1");
    vi.advanceTimersByTime(1_000);
    inputTranscript(socket, "Check the sensor", "u1");
    vi.advanceTimersByTime(1_000);
    expect(finalTranscripts(onTranscript)).toEqual([]);
    vi.advanceTimersByTime(500);
    expect(finalTranscripts(onTranscript)).toEqual([snapshot("Check the sensor")]);
    vi.useRealTimers();
  });
});
