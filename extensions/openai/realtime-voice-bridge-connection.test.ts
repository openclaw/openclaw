import { REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ } from "openclaw/plugin-sdk/realtime-voice";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceGatewayControl,
} from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const mocks = await vi.hoisted(async () => {
  const { createOpenAIRealtimeMockState } = await import("./realtime-voice-test-support.js");
  return createOpenAIRealtimeMockState();
});
const { FakeWebSocket, fetchWithSsrFGuardMock } = mocks;

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: mocks.execFileSyncMock,
  };
});

vi.mock("openclaw/plugin-sdk/websocket-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/websocket-runtime")>()),
  WebSocket: mocks.FakeWebSocket,
}));

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

const {
  parseSent,
  createNativeBridge,
  connectReadyBridge,
  requireSocket,
  beginBridgeConnection,
  openSocket,
  emitServerEvent,
  emitSessionUpdated,
  expectedResponseCreateEvent,
  requireRecord,
  expectRecordFields,
  requireSession,
  createRealtimeTool,
  createUnreadableToolName,
  createMalformedToolName,
  resetTestState,
  restoreTestEnvironment,
  createQuicksilverBrowserBrokerFixture,
} = createOpenAIRealtimeTestSupport({ ...mocks, buildOpenAIRealtimeVoiceProvider });

const turnDetection = (create_response = true, interrupt_response?: boolean) => ({
  type: "server_vad",
  threshold: 0.5,
  prefix_padding_ms: 300,
  silence_duration_ms: 500,
  create_response,
  ...(interrupt_response === undefined ? {} : { interrupt_response }),
});
const expectedGaSession = ({
  format = { type: "audio/pcmu" },
  voice = "alloy",
  transcription = { model: "gpt-4o-mini-transcribe" },
  vad = turnDetection(true, true),
  noise_reduction = null,
  ...fields
}: {
  format?: { type: string; rate?: number };
  voice?: string;
  transcription?: { model: string; language?: string };
  vad?: ReturnType<typeof turnDetection>;
  noise_reduction?: { type: string } | null;
  model?: string;
  instructions?: string;
  reasoning?: { effort: string };
  tool_choice?: string;
} = {}) => ({
  type: "realtime",
  ...fields,
  output_modalities: ["audio"],
  audio: {
    input: { format, noise_reduction, transcription, turn_detection: vad },
    output: { format, voice },
  },
});
const sessionUpdate = (session: unknown) => ({ type: "session.update", session });
const gaVadUpdate = (respond: boolean) =>
  sessionUpdate({ type: "realtime", audio: { input: { turn_detection: turnDetection(respond) } } });
const sentAudio = (socket: ReturnType<typeof requireSocket>) =>
  parseSent(socket).filter((event) => event.type === "input_audio_buffer.append");

describe("OpenAI realtime voice bridge connection", () => {
  beforeEach(resetTestState);
  afterEach(restoreTestEnvironment);

  it("uses the configured realtime endpoint without minting a client secret", async () => {
    const baseUrl =
      "wss://voice.example.test/custom/inference/?realtime=true&signature=a~b%20c&m%6fdel=old";
    const provider = buildOpenAIRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "test-realtime-key", baseUrl, model: "custom/realtime model" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });
    const socket = await connectReadyBridge(bridge);
    try {
      const url = new URL(String(socket.args[0]));
      const expected = new URL(baseUrl);
      expect(url.protocol).toBe(expected.protocol.replace("http", "ws"));
      expect(url.host).toBe(expected.host);
      expect(url.pathname).toBe(expected.pathname);
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
    "file:///private/voice",
    "https://user@voice.example.test/realtime",
    "wss://voice.example.test/realtime#secret",
    123,
  ])("rejects invalid realtime baseUrl without opening a socket (%s)", (baseUrl) => {
    expect(() =>
      buildOpenAIRealtimeVoiceProvider().createBridge({
        providerConfig: { apiKey: "test-realtime-key", baseUrl },
        onAudio: vi.fn(),
        onClearAudio: vi.fn(),
      }),
    ).toThrow("Invalid OpenAI realtime baseUrl");
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it("rejects mixing a realtime baseUrl with Azure routing", () => {
    expect(() =>
      buildOpenAIRealtimeVoiceProvider().createBridge({
        providerConfig: {
          apiKey: "test-realtime-key",
          baseUrl: "wss://voice.example.test/realtime",
          azureEndpoint: "https://example.openai.azure.com",
        },
        onAudio: vi.fn(),
        onClearAudio: vi.fn(),
      }),
    ).toThrow("cannot be combined with Azure");
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it.each([true, false])(
    "shares GA policy and retires the gateway binding with throwing callback=%s",
    async (throwingCloseCallback) => {
      const { broker, createBrowserSession } =
        createQuicksilverBrowserBrokerFixture("gateway-token");
      const provider = buildOpenAIRealtimeVoiceProvider({
        quicksilverBrowserSessionBroker: broker,
      });
      const bindBridge = vi.fn();
      const bindControl = vi.fn<NonNullable<RealtimeVoiceGatewayControl["bindControl"]>>();
      const onReady = vi.fn();
      const onClose = vi.fn(() => {
        if (throwingCloseCallback) {
          throw new Error("close callback failed");
        }
      });
      const onTerminal = vi.fn();
      const cfg = {} as never;

      await expect(
        provider.createBrowserSession?.({
          cfg,
          providerConfig: {
            apiKey: "test-api-key-platform",
            inputTranscriptionModel: "transcribe-prod",
          },
          instructions: "Stay concise.",
          model: "gpt-realtime-2.1",
          prefixPaddingMs: 420,
          reasoningEffort: "medium",
          silenceDurationMs: 650,
          tools: [createRealtimeTool("openclaw_agent_consult")],
          vadThreshold: 0.7,
          voice: "marin",
          clientControl: { owner: "gateway" },
          gatewayControl: {
            bindBridge,
            bindControl,
            onReady,
            onClose,
          },
        }),
      ).resolves.toMatchObject({
        clientSecret: "gateway-token",
        offerUrl: "/plugins/openai/realtime/calls",
      });
      const brokerRequest = requireRecord(
        createBrowserSession.mock.calls[0]?.[0],
        "broker request",
      );
      expect(createBrowserSession.mock.calls[0]?.[1]).toEqual({
        type: "api-key",
        token: "test-api-key-platform",
      });
      const gaSideband = requireRecord(brokerRequest.gaSideband, "GA sideband request");
      const gaSession = requireRecord(brokerRequest.gaSession, "GA session policy");
      expect(gaSession).toMatchObject(
        expectedGaSession({
          model: "gpt-realtime-2.1",
          instructions: "Stay concise.",
          reasoning: { effort: "medium" },
          tool_choice: "auto",
          format: { type: "audio/pcm", rate: 24000 },
          voice: "marin",
          noise_reduction: { type: "near_field" },
          transcription: { model: "transcribe-prod" },
          vad: {
            ...turnDetection(true, true),
            threshold: 0.7,
            prefix_padding_ms: 420,
            silence_duration_ms: 650,
          },
        }),
      );
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
      const socket = await connectReadyBridge(bridge);
      expect(socket.args[0]).toBe("wss://api.openai.com/v1/realtime?call_id=rtc_gateway");
      expect(parseSent(socket)).toEqual([sessionUpdate(gaSession)]);
      expect(onReady).toHaveBeenCalledOnce();

      const control = bindControl.mock.calls[0]?.[0];
      if (!control?.sendUserMessage) {
        throw new Error("Expected GA text control");
      }
      control.sendUserMessage("Read the current status");
      expect(parseSent(socket)).toContainEqual({
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
    const onReady = vi.fn();
    const bridge = createNativeBridge({
      onReady,
    });
    const { connecting, socket } = beginBridgeConnection(bridge);
    let connectResolved = false;
    void connecting.then(() => {
      connectResolved = true;
    });

    openSocket(socket);
    await Promise.resolve();

    bridge.sendAudio(Buffer.from("before-ready"));
    emitServerEvent(socket, { type: "session.created" });

    expect(connectResolved).toBe(false);
    expect(onReady).not.toHaveBeenCalled();
    expect(parseSent(socket).map((event) => event.type)).toEqual(["session.update"]);
    expect(bridge.isConnected()).toBe(false);

    emitSessionUpdated(socket);
    await connecting;

    expect(connectResolved).toBe(true);
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(parseSent(socket).map((event) => event.type)).toEqual([
      "session.update",
      "input_audio_buffer.append",
    ]);
    expect(bridge.isConnected()).toBe(true);
  });

  it("bounds queued audio by aggregate bytes before session readiness", async () => {
    const bridge = createNativeBridge();
    const { connecting, socket } = beginBridgeConnection(bridge);
    openSocket(socket);
    await Promise.resolve();

    bridge.sendAudio(Buffer.alloc(512 * 1024, 0x01));
    bridge.sendAudio(Buffer.alloc(512 * 1024, 0x02));
    bridge.sendAudio(Buffer.from("overflow"));
    emitSessionUpdated(socket);
    await connecting;

    const audioEvents = sentAudio(socket);
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
    const { connecting, socket } = beginBridgeConnection(bridge);
    openSocket(socket);
    bridge.sendAudio(Buffer.from("queued-before-ready"));
    socket.bufferedAmount = 1024 * 1024 + 1;
    emitSessionUpdated(socket);
    await connecting;

    expect(sentAudio(socket)).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      "OpenAI realtime input audio backpressure; droppedFrames=1",
    );
    await bridge.close();
  });

  it.each(["idle", "before-open", "before-ready"] as const)(
    "cancels %s audio and reconnects without stale frames",
    async (phase) => {
      const onClose = vi.fn();
      const bridge = createNativeBridge({ onClose });
      bridge.sendAudio(Buffer.from("queued-before-connect"));
      const attempt = phase === "idle" ? undefined : beginBridgeConnection(bridge);
      if (phase === "before-ready" && attempt) {
        openSocket(attempt.socket);
      }
      bridge.sendAudio(Buffer.from("queued-before-close"));
      void bridge.close();
      void bridge.close();
      await expect(Promise.resolve(attempt?.connecting)).resolves.toBeUndefined();
      if (attempt) {
        expect(attempt.socket).toMatchObject({ closed: true, terminated: false });
        expect(onClose).toHaveBeenCalledExactlyOnceWith("completed");
      } else {
        expect(FakeWebSocket.instances).toHaveLength(0);
        expect(onClose).not.toHaveBeenCalled();
      }
      bridge.sendAudio(Buffer.from("sent-after-close"));
      const socket = await connectReadyBridge(bridge, attempt ? 1 : 0);
      expect(sentAudio(socket)).toHaveLength(0);
      await bridge.close();
      expect(onClose).toHaveBeenCalledTimes(attempt ? 2 : 1);
    },
  );

  it("fails terminally when the readiness callback throws", async () => {
    vi.useFakeTimers();
    const readyError = new Error("readiness callback failed");
    const onClose = vi.fn();
    const onError = vi.fn();
    const onReady = vi.fn(() => {
      throw readyError;
    });
    const bridge = createNativeBridge({ onClose, onError, onReady });
    const { connecting, socket } = beginBridgeConnection(bridge);
    let connectError: unknown;
    const observedConnect = connecting.catch((error: unknown) => {
      connectError = error;
    });

    openSocket(socket);
    bridge.sendAudio(Buffer.from("queued-before-ready"));
    emitSessionUpdated(socket);
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
    expect(sentAudio(socket)).toHaveLength(0);

    emitSessionUpdated(socket);
    await expect(bridge.connect()).rejects.toBe(readyError);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(onReady).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("omits unsupported OpenAI tool names from GA session updates", async () => {
    const bridge = createNativeBridge({
      tools: [
        createRealtimeTool("1_lookup"),
        createRealtimeTool("calendar.lookup:next"),
        createRealtimeTool("bad/name"),
        createRealtimeTool("x".repeat(65)),
        createMalformedToolName(null),
        createMalformedToolName(42),
        createUnreadableToolName(),
      ],
    });
    const socket = await connectReadyBridge(bridge);
    const tools = requireSession(socket).tools as Array<{ name?: string }>;
    expect(tools.map((tool) => tool.name)).toEqual(["1_lookup", "x".repeat(65)]);
  });

  it("uses a configured input transcription model in the GA session payload", async () => {
    const bridge = createNativeBridge({
      instructions: "Be helpful.",
      language: "de",
      providerConfig: {
        apiKey: "test-key",
        inputTranscriptionModel: "transcribe-prod",
      },
    });
    const socket = await connectReadyBridge(bridge);
    expect(requireSession(socket)).toMatchObject({
      model: "gpt-realtime-2.1",
      instructions: "Be helpful.",
      audio: {
        input: {
          format: { type: "audio/pcmu" },
          transcription: { model: "transcribe-prod", language: "de" },
        },
        output: { format: { type: "audio/pcmu" }, voice: "alloy" },
      },
    });
  });

  it.each([
    { inputTranscriptionModel: undefined, deploymentField: "azureDeployment" },
    { inputTranscriptionModel: "transcribe-prod", deploymentField: "azureDeployment" },
    { inputTranscriptionModel: undefined, deploymentField: "model" },
  ])(
    "uses the Azure GA route and matching session payload with $deploymentField and transcription=$inputTranscriptionModel",
    async ({ inputTranscriptionModel, deploymentField }) => {
      const bridge = createNativeBridge({
        providerConfig: {
          apiKey: "test-api-key-test",
          azureEndpoint: "https://example.openai.azure.com/openai/",
          [deploymentField]: "realtime-prod",
          voice: "verse",
          inputTranscriptionModel,
          reasoningEffort: "low",
          temperature: 0.9,
        },
        audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
        instructions: "Be helpful.",
        tools: [
          createRealtimeTool("1_lookup"),
          createRealtimeTool("calendar.lookup:next"),
          createRealtimeTool("x".repeat(65)),
        ],
      });
      const { connecting, socket } = beginBridgeConnection(bridge);

      expect(socket.args[0]).toBe(
        "wss://example.openai.azure.com/openai/v1/realtime?model=realtime-prod",
      );
      expect(socket.args[1]).toMatchObject({ headers: { "api-key": "test-api-key-test" } });
      expect((socket.args[1] as { headers: Record<string, string> }).headers).not.toHaveProperty(
        "Authorization",
      );

      openSocket(socket);
      await Promise.resolve();

      const session = requireSession(socket);
      expectRecordFields(
        session,
        "session",
        expectedGaSession({
          instructions: "Be helpful.",
          format: { type: "audio/pcm", rate: 24000 },
          voice: "verse",
          transcription: { model: inputTranscriptionModel ?? "whisper-1" },
          vad: turnDetection(),
        }),
      );
      for (const key of ["modalities", "temperature", "model", "reasoning"]) {
        expect(session).not.toHaveProperty(key);
      }
      expect(session).not.toHaveProperty("input_audio_format");
      const tools = session.tools as Array<{ name?: string }>;
      expect(tools.map((tool) => tool.name)).toEqual(["1_lookup"]);

      emitSessionUpdated(socket);
      await connecting;

      bridge.triggerGreeting?.("Say hello.");
      expect(parseSent(socket).slice(-2)).toEqual([
        gaVadUpdate(false),
        expectedResponseCreateEvent(),
      ]);

      emitServerEvent(socket, { type: "response.done" });
      expect(parseSent(socket).at(-1)).toEqual(gaVadUpdate(true));
    },
  );

  it.each([
    { suffix: "", inputTranscriptionModel: undefined },
    { suffix: "/openai", inputTranscriptionModel: "transcribe-prod" },
  ])(
    "preserves the explicit Azure preview wire contract for $suffix",
    async ({ suffix, inputTranscriptionModel }) => {
      const bridge = createNativeBridge({
        providerConfig: {
          apiKey: "azure-test-key",
          azureEndpoint: `https://example.openai.azure.com${suffix}/`,
          azureDeployment: "realtime-prod",
          azureApiVersion: "2024-10-01-preview",
          inputTranscriptionModel,
        },
      });
      const { connecting, socket } = beginBridgeConnection(bridge);
      expect(socket.args[0]).toBe(
        `wss://example.openai.azure.com${suffix}/openai/realtime?api-version=2024-10-01-preview&deployment=realtime-prod`,
      );
      const options = socket.args[1] as { headers?: Record<string, string> };
      expect(options.headers?.["api-key"]).toBe("azure-test-key");
      expect(options.headers).not.toHaveProperty("Authorization");

      openSocket(socket);
      await Promise.resolve();
      const session = requireSession(socket);
      expect(session).not.toHaveProperty("audio");
      expect(session).toEqual({
        modalities: ["text", "audio"],
        voice: "alloy",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        input_audio_transcription: { model: inputTranscriptionModel ?? "whisper-1" },
        turn_detection: turnDetection(),
        temperature: 0.8,
      });
      emitSessionUpdated(socket);
      await connecting;

      bridge.triggerGreeting?.("Say hello.");
      expect(parseSent(socket).at(-2)).toMatchObject({
        type: "session.update",
        session: { turn_detection: { create_response: false } },
      });
      emitServerEvent(socket, { type: "response.done" });
      expect(parseSent(socket).at(-1)).toMatchObject({
        type: "session.update",
        session: { turn_detection: { create_response: true } },
      });
    },
  );

  it("rejects connection when the socket closes before session readiness", async () => {
    const bridge = createNativeBridge();
    const { connecting, socket } = beginBridgeConnection(bridge);

    openSocket(socket);
    socket.close(1006, "session closed");

    await expect(connecting).rejects.toThrow("OpenAI realtime connection closed before ready");
    expect(bridge.isConnected()).toBe(false);
  });

  it("bounds sideband frames received before session readiness", async () => {
    const bridge = createNativeBridge();
    const { connecting, socket } = beginBridgeConnection(bridge);
    openSocket(socket);
    const frame = Buffer.from(
      JSON.stringify({ type: "session.created", padding: "x".repeat(600 * 1024) }),
    );

    socket.emit("message", frame);
    socket.emit("message", frame);

    await expect(connecting).rejects.toThrow("sideband startup buffer exceeded");
    expect(bridge.isConnected()).toBe(false);
  });

  it("does not report startup timeout shutdown as a clean close", async () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const bridge = createNativeBridge({ onClose });
    const { connecting, socket } = beginBridgeConnection(bridge);

    const timeoutAssertion = expect(connecting).rejects.toThrow(
      "OpenAI realtime connection timeout",
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await timeoutAssertion;
    expect(socket.terminated).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(bridge.isConnected()).toBe(false);
  });
});
