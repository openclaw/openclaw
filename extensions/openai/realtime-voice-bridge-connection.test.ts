import { once } from "node:events";
import { MessageChannel } from "node:worker_threads";
import { REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ } from "openclaw/plugin-sdk/realtime-voice";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceGatewayControl,
} from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAIQuicksilverGatewayBridge } from "./realtime-quicksilver-gateway-bridge.js";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const mocks = await vi.hoisted(async () => {
  const { createOpenAIRealtimeMockState } = await import("./realtime-voice-test-support.js");
  return createOpenAIRealtimeMockState();
});
const { FakeWebSocket, fetchWithSsrFGuardMock } = mocks;

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: mocks.execFileSyncMock,
}));
vi.mock("ws", () => ({ default: mocks.FakeWebSocket }));

vi.mock("./realtime-quicksilver-socket.js", async () => {
  const { createTestMediaSocketFactory } = await import("./realtime-voice-test-support.js");
  return {
    OpenAIQuicksilverWorkerSocket: {
      create: await createTestMediaSocketFactory(mocks.FakeWebSocket),
    },
  };
});

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: mocks.fetchWithSsrFGuardMock,
}));

// mock-isolation: Connection tests own credential outcomes and must not consult host auth storage.
vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  isProviderAuthProfileConfigured: mocks.isProviderAuthProfileConfiguredMock,
  isProviderAuthProfileConfiguredAsync: mocks.isProviderAuthProfileConfiguredMock,
  resolveProviderAuthProfileApiKey: mocks.resolveProviderAuthProfileApiKeyMock,
}));
import { createOpenAIRealtimeTestSupport } from "./realtime-voice-test-support.js";

const rt = createOpenAIRealtimeTestSupport({ ...mocks, buildOpenAIRealtimeVoiceProvider });

type Socket = ReturnType<typeof rt.requireSocket>;
let onClose: ReturnType<typeof vi.fn>;
let onError: ReturnType<typeof vi.fn>;
let onReady: ReturnType<typeof vi.fn>;

function sentEvents(socket: Socket, type: string) {
  return rt.parseSent(socket).filter((event) => event.type === type);
}

const vadDefaults = {
  type: "server_vad",
  threshold: 0.5,
  prefix_padding_ms: 300,
  silence_duration_ms: 500,
};
function serverVad(
  create_response = true,
  overrides: Partial<typeof vadDefaults> & { interrupt_response?: boolean } = {},
) {
  return { ...vadDefaults, create_response, ...overrides };
}

function azureVadUpdate(createResponse: boolean) {
  return { type: "session.update", session: { turn_detection: serverVad(createResponse) } };
}

function expectedGaPolicy(mode: "sideband" | "native") {
  const sideband = mode === "sideband";
  const format = sideband ? { type: "audio/pcm", rate: 24000 } : { type: "audio/pcmu" };
  return {
    type: "realtime",
    model: "gpt-realtime-2.1",
    instructions: sideband ? "Stay concise." : "Be helpful.",
    output_modalities: ["audio"],
    ...(sideband ? { reasoning: { effort: "medium" }, tool_choice: "auto" } : {}),
    audio: {
      input: {
        format,
        noise_reduction: sideband ? { type: "near_field" } : null,
        ...(!sideband
          ? { transcription: { model: "gpt-4o-mini-transcribe", language: "de" } }
          : {}),
        turn_detection: serverVad(true, {
          interrupt_response: true,
          ...(sideband ? { threshold: 0.7, prefix_padding_ms: 420, silence_duration_ms: 650 } : {}),
        }),
      },
      output: { format, voice: sideband ? "marin" : "alloy" },
    },
  };
}

function createConfiguredBridge(providerConfig: Record<string, unknown>) {
  return rt.createNativeBridge({ providerConfig });
}

function startBridge(overrides: Parameters<typeof rt.createNativeBridge>[0] = {}, open = true) {
  const bridge = rt.createNativeBridge(overrides);
  const connection = rt.beginBridgeConnection(bridge);
  if (open) {
    rt.openSocket(connection.socket);
  }
  return { bridge, ...connection };
}

describe("OpenAI realtime voice bridge connection", () => {
  beforeEach(() => {
    rt.resetTestState();
    onClose = vi.fn();
    onError = vi.fn();
    onReady = vi.fn();
  });
  afterEach(rt.restoreTestEnvironment);

  it("uses the configured realtime endpoint without minting a client secret", async () => {
    const baseUrl =
      "wss://voice.example.test/custom/inference/?realtime=true&signature=a~b%20c&m%6fdel=old";
    const bridge = createConfiguredBridge({
      apiKey: "test-realtime-key",
      baseUrl,
      model: "custom/realtime model",
    });
    const socket = await rt.connectReadyBridge(bridge);
    try {
      const url = new URL(String(socket.args[0]));
      const expected = new URL(baseUrl);
      expect(url).toMatchObject({
        protocol: expected.protocol.replace("http", "ws"),
        host: expected.host,
        pathname: expected.pathname,
      });
      expect(url.searchParams.get("realtime")).toBe("true");
      expect(url.search).toContain("signature=a~b%20c");
      expect(url.searchParams.getAll("model")).toEqual(["custom/realtime model"]);
      expect(socket.args[1]).toMatchObject({
        headers: { Authorization: "Bearer test-realtime-key" },
      });
      expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
      expect(bridge.isConnected()).toBe(true);
    } finally {
      await bridge.close();
    }
  });

  it.each([
    ["file:///private/voice", undefined],
    ["https://user@voice.example.test/realtime", undefined],
    ["wss://voice.example.test/realtime#secret", undefined],
    [123, undefined],
    ["wss://voice.example.test/realtime", "https://example.openai.azure.com"],
  ])("rejects invalid realtime routing (%s, Azure=%s)", (baseUrl, azureEndpoint) => {
    expect(() =>
      createConfiguredBridge({
        apiKey: "test-realtime-key",
        baseUrl,
        ...(azureEndpoint ? { azureEndpoint } : {}),
      }),
    ).toThrow(azureEndpoint ? "cannot be combined with Azure" : "Invalid OpenAI realtime baseUrl");
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "shares GA policy and retires the gateway binding with throwing callback=%s",
    async (throwingCloseCallback) => {
      const { broker, createBrowserSession } = rt.createQuicksilverBrowserBrokerFixture({
        session: { clientSecret: "gateway-token" },
      });
      const provider = buildOpenAIRealtimeVoiceProvider({
        quicksilverBrowserSessionBroker: broker,
      });
      const bindBridge = vi.fn();
      const bindControl = vi.fn<NonNullable<RealtimeVoiceGatewayControl["bindControl"]>>();
      const onEvent = vi.fn();
      onClose.mockImplementation(() => {
        if (throwingCloseCallback) {
          throw new Error("close callback failed");
        }
      });
      const onTerminal = vi.fn();
      const cfg = {} as never;

      expect(
        await rt
          .readInternalRealtimeVoiceProviderApi(provider)
          .resolveBrowserSessionCapabilitiesAsync({
            cfg,
            providerConfig: { apiKey: "test-api-key-platform" },
            model: "gpt-realtime-2.1",
          }),
      ).toMatchObject({ supportsGatewayControl: true });
      await expect(
        provider.createBrowserSession?.({
          cfg,
          providerConfig: { apiKey: "test-api-key-platform" },
          instructions: "Stay concise.",
          model: "gpt-realtime-2.1",
          prefixPaddingMs: 420,
          reasoningEffort: "medium",
          silenceDurationMs: 650,
          tools: [rt.createRealtimeTool("openclaw_agent_consult")],
          vadThreshold: 0.7,
          voice: "marin",
          clientControl: { owner: "gateway" },
          gatewayControl: {
            bindBridge,
            bindControl,
            onEvent,
            onReady,
            onClose,
          },
        }),
      ).resolves.toMatchObject({
        clientSecret: "gateway-token",
        offerUrl: "/plugins/openai/realtime/calls",
      });
      const brokerRequest = rt.requireRecord(
        createBrowserSession.mock.calls[0]?.[0],
        "broker request",
      );
      expect(brokerRequest.clientControl).toEqual({ owner: "gateway" });
      expect(createBrowserSession.mock.calls[0]?.[1]).toEqual({
        type: "api-key",
        token: "test-api-key-platform",
      });
      const gaSideband = rt.requireRecord(brokerRequest.gaSideband, "GA sideband request");
      const gaSession = rt.requireRecord(brokerRequest.gaSession, "GA session policy");
      expect(gaSession).toMatchObject(expectedGaPolicy("sideband"));
      const createBridge = gaSideband.createBridge as (params: {
        apiKey: string;
        callId: string;
        onTerminal: () => void;
      }) => RealtimeVoiceBridge;
      const bridge = createBridge({
        apiKey: "test-api-key-platform",
        callId: "rtc_gateway",
        onTerminal,
      });
      expect(bindControl).toHaveBeenCalledOnce();
      expect(bindBridge).not.toHaveBeenCalled();
      const { connecting, socket } = rt.beginBridgeConnection(bridge);
      let connectResolved = false;
      void connecting.then(() => {
        connectResolved = true;
      });
      expect(socket.args[0]).toBe("wss://api.openai.com/v1/realtime?call_id=rtc_gateway");
      rt.openSocket(socket);
      await Promise.resolve();
      const sessionUpdates = sentEvents(socket, "session.update");
      expect(sessionUpdates).toHaveLength(1);
      expect(sessionUpdates[0]?.session).toEqual(gaSession);
      rt.emitServerEvent(socket, {
        type: "session.created",
        session: { type: "realtime", tools: [{ type: "function" }], tool_choice: "auto" },
      });
      await Promise.resolve();
      expect(connectResolved).toBe(false);
      expect(onReady).not.toHaveBeenCalled();
      expect(sentEvents(socket, "session.update")).toHaveLength(1);
      rt.emitSessionUpdated(socket);
      await connecting;
      expect(connectResolved).toBe(true);
      expect(onReady).toHaveBeenCalledOnce();
      expect(onEvent).toHaveBeenCalledWith({
        direction: "server",
        type: "session.created",
        detail: "tools=1 toolChoice=auto",
      });

      bridge.setMediaTimestamp(1_000);
      rt.emitServerEvent(socket, {
        type: "response.output_audio.delta",
        item_id: "item_pcm",
        delta: Buffer.alloc(3_700 * 48).toString("base64"),
      });
      bridge.setMediaTimestamp(4_760);
      bridge.handleBargeIn?.({ audioPlaybackActive: true });

      expect(rt.parseSent(socket).slice(-2)).toEqual([
        {
          type: "response.cancel",
          event_id: expect.stringMatching(/^openclaw-response-cancel-/),
        },
        {
          type: "conversation.item.truncate",
          item_id: "item_pcm",
          content_index: 0,
          audio_end_ms: 3_700,
        },
      ]);
      const control = bindControl.mock.calls[0]?.[0];
      if (!control?.sendUserMessage || !control.submitToolResult) {
        throw new Error("Expected both GA control operations");
      }
      await control.submitToolResult("unknown-call", {});
      control.sendUserMessage("Read the current status");
      expect(rt.parseSent(socket)).toContainEqual({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Read the current status" }],
        },
      });
      if (throwingCloseCallback) {
        expect(() => bridge.close()).toThrow("close callback failed");
      } else {
        await bridge.close();
      }
      expect(onClose).toHaveBeenCalledOnce();
      expect(onTerminal).toHaveBeenCalledOnce();
      expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
    },
  );

  it("waits for session.updated before draining audio and firing onReady", async () => {
    const { bridge, connecting, socket } = startBridge(
      { instructions: "Be helpful.", language: "de", onReady },
      false,
    );
    let connectResolved = false;
    void connecting.then(() => {
      connectResolved = true;
    });

    rt.openSocket(socket);
    await Promise.resolve();

    bridge.sendAudio(Buffer.from("before-ready"));
    rt.emitServerEvent(socket, { type: "session.created" });

    expect(connectResolved).toBe(false);
    expect(onReady).not.toHaveBeenCalled();
    expect(rt.parseSent(socket).map((event) => event.type)).toEqual(["session.update"]);
    expect(socket.sent[0]).toBe(
      JSON.stringify({
        type: "session.update",
        session: expectedGaPolicy("native"),
      }),
    );
    expect(bridge.isConnected()).toBe(false);

    rt.emitSessionUpdated(socket);
    await connecting;

    expect(connectResolved).toBe(true);
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(rt.parseSent(socket).map((event) => event.type)).toEqual([
      "session.update",
      "input_audio_buffer.append",
    ]);
    expect(bridge.isConnected()).toBe(true);
  });

  it("bounds queued audio by aggregate bytes before session readiness", async () => {
    const { bridge, connecting, socket } = startBridge();
    await Promise.resolve();

    bridge.sendAudio(Buffer.alloc(512 * 1024, 0x01));
    bridge.sendAudio(Buffer.alloc(512 * 1024, 0x02));
    bridge.sendAudio(Buffer.from("overflow"));
    rt.emitSessionUpdated(socket);
    await connecting;

    const audioEvents = sentEvents(socket, "input_audio_buffer.append");
    expect(audioEvents).toHaveLength(2);
    expect(
      audioEvents.map((event) => Buffer.from(String(event.audio), "base64").byteLength),
    ).toEqual([512 * 1024, Buffer.byteLength("overflow")]);
    await bridge.close();
  });

  it("routes readiness-drained audio through websocket backpressure", async () => {
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const provider = buildOpenAIRealtimeVoiceProvider({ logger });
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "test-api-key-test" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });
    const { connecting, socket } = rt.beginBridgeConnection(bridge);
    rt.openSocket(socket);
    bridge.sendAudio(Buffer.from("queued-before-ready"));
    socket.bufferedAmount = 1024 * 1024 + 1;
    rt.emitSessionUpdated(socket);
    await connecting;

    expect(sentEvents(socket, "input_audio_buffer.append")).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      "OpenAI realtime input audio backpressure; droppedFrames=1",
    );
    await bridge.close();
  });

  it.each([false, true])(
    "discards queued audio across close (connection started=%s)",
    async (started) => {
      const bridge = rt.createNativeBridge({ onClose });
      const first = started ? rt.beginBridgeConnection(bridge) : undefined;
      if (first) {
        rt.openSocket(first.socket);
        await Promise.resolve();
      }
      bridge.sendAudio(Buffer.from("queued-before-close"));
      void bridge.close();
      if (first) {
        await first.connecting;
      } else {
        void bridge.close();
        expect(FakeWebSocket.instances).toHaveLength(0);
        expect(onClose).not.toHaveBeenCalled();
      }
      bridge.sendAudio(Buffer.from("sent-after-close"));
      const socket = await rt.connectReadyBridge(bridge, started ? 1 : 0);
      expect(sentEvents(socket, "input_audio_buffer.append")).toHaveLength(0);
      await bridge.close();
      expect(onClose).toHaveBeenCalledTimes(started ? 2 : 1);
      expect(onClose).toHaveBeenLastCalledWith("completed");
    },
  );

  it("fails terminally when the readiness callback throws", async () => {
    vi.useFakeTimers();
    const readyError = new Error("readiness callback failed");
    onReady.mockImplementation(() => {
      throw readyError;
    });
    const { bridge, connecting, socket } = startBridge({ onClose, onError, onReady }, false);
    let connectError: unknown;
    const observedConnect = connecting.catch((error: unknown) => {
      connectError = error;
    });

    rt.openSocket(socket);
    bridge.sendAudio(Buffer.from("queued-before-ready"));
    rt.emitSessionUpdated(socket);
    await vi.advanceTimersByTimeAsync(0);
    const immediateConnectError = connectError;

    await bridge.close();
    await observedConnect;

    expect(immediateConnectError).toBe(readyError);
    expect(onReady).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledExactlyOnceWith(readyError);
    expect(onClose).toHaveBeenCalledExactlyOnceWith("error");
    expect(socket.closed).toBe(true);
    expect(bridge.isConnected()).toBe(false);
    expect(sentEvents(socket, "input_audio_buffer.append")).toHaveLength(0);

    rt.emitSessionUpdated(socket);
    await expect(bridge.connect()).rejects.toBe(readyError);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(onReady).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("omits unsupported OpenAI tool names from GA session updates", async () => {
    const { connecting, socket } = startBridge({
      tools: [
        ...["1_lookup", "calendar.lookup:next", "bad/name", "x".repeat(65)].map(
          rt.createRealtimeTool,
        ),
        rt.createMalformedToolName(null),
        rt.createMalformedToolName(42),
        rt.createUnreadableToolName(),
      ],
    });
    const tools = rt.requireSession(socket).tools as Array<{ name?: string }>;
    expect(tools.map((tool) => tool.name)).toEqual(["1_lookup", "x".repeat(65)]);
    rt.emitSessionUpdated(socket);
    await connecting;
  });

  it("keeps Azure deployment bridges on deployment-compatible session payloads", async () => {
    const { bridge, connecting, socket } = startBridge(
      {
        providerConfig: {
          apiKey: "test-api-key-test",
          azureEndpoint: "https://example.openai.azure.com/",
          azureDeployment: "realtime-prod",
          azureApiVersion: "2024-10-01-preview",
          voice: "verse",
        },
        audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
        instructions: "Be helpful.",
        tools: ["1_lookup", "calendar.lookup:next", "x".repeat(65)].map(rt.createRealtimeTool),
      },
      false,
    );

    expect(socket.args[0]).toBe(
      "wss://example.openai.azure.com/openai/realtime?api-version=2024-10-01-preview&deployment=realtime-prod",
    );

    rt.openSocket(socket);
    await Promise.resolve();

    const session = rt.requireSession(socket);
    rt.expectRecordFields(session, "session", {
      modalities: ["text", "audio"],
      instructions: "Be helpful.",
      voice: "verse",
      input_audio_format: "pcm16",
      output_audio_format: "pcm16",
      input_audio_transcription: { model: "whisper-1" },
      temperature: 0.8,
    });
    expect(session.turn_detection).toMatchObject({ create_response: true });
    expect(session).not.toHaveProperty("type");
    expect(session).not.toHaveProperty("audio");
    const tools = session.tools as Array<{ name?: string }>;
    expect(tools.map((tool) => tool.name)).toEqual(["1_lookup"]);

    rt.emitSessionUpdated(socket);
    await connecting;

    bridge.triggerGreeting?.("Say hello.");
    expect(rt.parseSent(socket).slice(-2)).toEqual([
      azureVadUpdate(false),
      rt.expectedResponseCreateEvent(),
    ]);

    rt.emitServerEvent(socket, { type: "response.done" });
    expect(rt.parseSent(socket).at(-1)).toEqual(azureVadUpdate(true));
  });

  it.each([
    ["socket close", "OpenAI realtime connection closed before ready"],
    ["buffer overflow", "sideband startup buffer exceeded"],
    ["timeout", "OpenAI realtime connection timeout"],
  ])("rejects pre-ready %s without reporting connected", async (failure, message) => {
    if (failure === "timeout") {
      vi.useFakeTimers();
    }
    const { bridge, connecting, socket } = startBridge({ onClose }, failure !== "timeout");
    const rejected = expect(connecting).rejects.toThrow(message);
    if (failure === "socket close") {
      socket.close(1006, "session closed");
    } else if (failure === "buffer overflow") {
      const frame = Buffer.from(
        JSON.stringify({ type: "session.created", padding: "x".repeat(600 * 1024) }),
      );
      socket.emit("message", frame);
      socket.emit("message", frame);
    } else {
      await vi.advanceTimersByTimeAsync(10_000);
      expect(socket.terminated).toBe(true);
      expect(onClose).not.toHaveBeenCalled();
      expect(FakeWebSocket.instances).toHaveLength(1);
    }
    await rejected;
    expect(bridge.isConnected()).toBe(false);
  });

  it("routes registered GPT-Live Gateway PCM to the pre-connected output port and drains final transcripts", async () => {
    const { port1, port2 } = new MessageChannel();
    const state = new SharedArrayBuffer(4);
    const onAudio = vi.fn();
    const onTranscript = vi.fn();
    const runAgentConsult = vi.fn(async () => ({ text: "Delegated answer" }));
    const bridge = buildOpenAIRealtimeVoiceProvider().createBridge({
      providerConfig: { apiKey: "fixture-key", model: "gpt-live-1" },
      audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      onAudio,
      onClearAudio: vi.fn(),
      onReady,
      onClose,
      onTranscript,
      runAgentConsult,
    });
    try {
      expect(bridge).toBeInstanceOf(OpenAIQuicksilverGatewayBridge);
      if (!bridge.setAudioOutputPort) {
        throw new Error("registered GPT-Live bridge lacks its audio output endpoint");
      }
      bridge.setAudioOutputPort({ port: port1, state });
      expect(FakeWebSocket.instances).toHaveLength(0);
      const connecting = bridge.connect();
      await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      const socket = rt.requireSocket();
      rt.openSocket(socket);
      await vi.waitFor(() =>
        expect(rt.parseSent(socket)).toContainEqual(
          expect.objectContaining({ type: "session.start" }),
        ),
      );
      expect(onReady).not.toHaveBeenCalled();
      rt.emitServerEvent(socket, { type: "session.started", session: {} });
      await connecting;
      expect(onReady).toHaveBeenCalledOnce();
      expect(bridge.isConnected()).toBe(true);
      const pcm = Buffer.alloc(960, 1);
      const output = once(port2, "message");
      rt.emitServerEvent(socket, {
        type: "session.output_audio.delta",
        delta: pcm.toString("base64"),
      });
      expect((await output)[0]).toEqual({ type: "audio", audio: new Uint8Array(pcm) });
      expect(onAudio).not.toHaveBeenCalled();
      const closing = bridge.close({ disposition: "detach" });
      expect(closing).toBeInstanceOf(Promise);
      expect(Atomics.load(new Int32Array(state), 0)).toBe(1);
      expect(onClose).not.toHaveBeenCalled();
      expect(socket.closed).toBe(false);
      rt.emitServerEvent(socket, {
        type: "session.input_transcript.delta",
        delta: "Trailing words.",
        start_ms: 0,
        end_ms: 100,
      });
      rt.emitServerEvent(socket, { type: "session.closed", reason: "close_requested" });
      await closing;
      expect(onTranscript).toHaveBeenCalledWith("user", "Trailing words.", true);
      expect(onClose).toHaveBeenCalledExactlyOnceWith("completed");
      expect(socket.closed).toBe(true);
      expect(runAgentConsult).not.toHaveBeenCalled();
      expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
    } finally {
      const closing = bridge.close();
      const socket = FakeWebSocket.instances[0];
      if (socket && !socket.closed) {
        rt.emitServerEvent(socket, { type: "session.closed", reason: "close_requested" });
      }
      await Promise.allSettled([closing]);
      port1.close();
      port2.close();
    }
  });

  it("settles cleanly when closed before the websocket opens", async () => {
    const { connecting, socket } = startBridge({ onClose }, false);

    void bridge.close();
    void bridge.close();

    await expect(connecting).resolves.toBeUndefined();
    expect(socket).toMatchObject({ closed: true, terminated: false });
    expect(onClose).toHaveBeenCalledExactlyOnceWith("completed");
  });
});
