import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ as PCM,
  resamplePcm,
  resolveConfiguredRealtimeVoiceProvider,
  type RealtimeVoiceTool,
} from "openclaw/plugin-sdk/realtime-voice";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLazyGoogleRealtimeVoiceProvider } from "./realtime-voice-lazy.js";
import { buildThinkingConfig } from "./realtime-voice-model-contract.js";
import { buildGoogleRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const CONSULT = "openclaw_agent_consult";
const LEGACY = "gemini-2.5-flash-native-audio-preview-12-2025";
const EXTENDED = "gemini-3.8-live-extended-thinking";

type MockGoogleLiveSession = ReturnType<typeof mockSession>;
type MockGoogleLiveConnectParams = {
  model: string;
  config: Record<string, unknown>;
  callbacks: {
    onopen: () => void;
    onmessage: (message: Record<string, unknown>) => void;
    onerror: (event: { error?: unknown; message?: string }) => void;
    onclose: (event?: { code?: number; reason?: string; wasClean?: boolean }) => void;
  };
};
const { connectMock, createGoogleGenAIMock, createTokenMock, session } = vi.hoisted(() => {
  const liveSession = {
    close: vi.fn(),
    sendClientContent: vi.fn(),
    sendRealtimeInput: vi.fn(),
    sendToolResponse: vi.fn(),
  };
  const connect = vi.fn(async (_params: MockGoogleLiveConnectParams) => liveSession);
  const createToken = vi.fn(async (_params: unknown) => ({
    name: "auth_tokens/browser-session",
  }));
  return {
    session: liveSession,
    connectMock: connect,
    createTokenMock: createToken,
    createGoogleGenAIMock: vi.fn(() => ({
      authTokens: { create: createToken },
      live: { connect },
    })),
  };
});
vi.mock("./google-genai-runtime.js", () => ({ createGoogleGenAI: createGoogleGenAIMock }));

function connection(): MockGoogleLiveConnectParams {
  const params = connectMock.mock.calls.at(-1)?.[0];
  if (!params) {
    throw new Error("expected google live connect call");
  }
  return params;
}
function receive(message: Record<string, unknown>) {
  connection().callbacks.onmessage(message);
}
function content(serverContent: Record<string, unknown>) {
  receive({ serverContent });
}
function callOrder(mock: ReturnType<typeof vi.fn>, index = 0) {
  const order = mock.mock.invocationCallOrder[index];
  if (order === undefined) {
    throw new Error("Expected mock invocation");
  }
  return order;
}
function callTool(id = "call-1", name = "lookup", args = {}) {
  receive({ toolCall: { functionCalls: [{ id, name, args }] } });
}
function disconnectWithTools(functionCalls = [{ id: "call-1", name: "lookup", args: {} }]) {
  receive({
    sessionResumptionUpdate: { resumable: true, newHandle: "resume-1" },
    toolCall: { functionCalls },
  });
  connection().callbacks.onclose({ code: 1011, reason: "temporary" });
}
function createRealtimeTool(name: string): RealtimeVoiceTool {
  return {
    type: "function",
    name,
    description: "Contract test tool",
    parameters: { type: "object", properties: {} },
  };
}
function createRealtimeToolDeclaration(name: string) {
  return {
    name,
    description: "Contract test tool",
    parameters: { type: "object", properties: {} },
  };
}
function createUnreadableToolName(): RealtimeVoiceTool {
  return {
    ...createRealtimeTool("lookup"),
    get name(): string {
      throw new Error("unreadable tool name");
    },
  };
}
function createMalformedToolName(name: unknown): RealtimeVoiceTool {
  return { ...createRealtimeTool("lookup"), name } as unknown as RealtimeVoiceTool;
}
function mockSession() {
  return {
    close: vi.fn(),
    sendClientContent: vi.fn(),
    sendRealtimeInput: vi.fn(),
    sendToolResponse: vi.fn(),
  };
}
type GoogleLiveBridgeParams = Parameters<
  ReturnType<typeof buildGoogleRealtimeVoiceProvider>["createBridge"]
>[0];
function createBridge(params: Partial<GoogleLiveBridgeParams> = {}) {
  const { providerConfig, ...callbacks } = params;
  return buildGoogleRealtimeVoiceProvider().createBridge({
    providerConfig: { apiKey: "gemini-key", ...providerConfig },
    onAudio: vi.fn(),
    onClearAudio: vi.fn(),
    ...callbacks,
  });
}
async function connectBridge(params: Partial<GoogleLiveBridgeParams> = {}) {
  const bridge = createBridge(params);
  await bridge.connect();
  return bridge;
}
function activate(callbacks = connection().callbacks, setupComplete = {}) {
  callbacks.onopen();
  callbacks.onmessage({ setupComplete });
}
function finalTranscripts(mock: ReturnType<typeof vi.fn>) {
  return mock.mock.calls.filter((call) => call[2] === true);
}
function rejectReconnects() {
  return connectMock
    .mockRejectedValueOnce(new Error("connect failed 1"))
    .mockRejectedValueOnce(new Error("connect failed 2"))
    .mockRejectedValueOnce(new Error("connect failed 3"));
}
function expectError(mock: ReturnType<typeof vi.fn>, message: string) {
  expect(mock).toHaveBeenCalledWith(expect.objectContaining({ message }));
}
async function openBridge(params: Partial<GoogleLiveBridgeParams> = {}) {
  const bridge = await connectBridge(params);
  activate();
  return bridge;
}

describe("buildGoogleRealtimeVoiceProvider", () => {
  let onAudio = vi.fn();
  let onClearAudio = vi.fn();
  let onClose = vi.fn();
  let onError = vi.fn();
  let onEvent = vi.fn();
  let onReady = vi.fn();
  let onResponseDone = vi.fn();
  let onToolCall = vi.fn();
  let onTranscript = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    onAudio = vi.fn();
    onClearAudio = vi.fn();
    onClose = vi.fn();
    onError = vi.fn();
    onEvent = vi.fn();
    onReady = vi.fn();
    onResponseDone = vi.fn();
    onToolCall = vi.fn();
    onTranscript = vi.fn();
    vi.stubEnv("GEMINI_API_KEY", undefined);
    vi.stubEnv("GOOGLE_API_KEY", undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  afterAll(() => {
    vi.doUnmock("./google-genai-runtime.js");
    vi.resetModules();
  });

  it.each([
    ["registered", buildGoogleRealtimeVoiceProvider],
    ["lazy", createLazyGoogleRealtimeVoiceProvider],
  ] as const)(
    "preserves public synchronous resolution for the %s provider",
    (_kind, buildProvider) => {
      const resolution = resolveConfiguredRealtimeVoiceProvider({
        cfg: {},
        configuredProviderId: "google",
        providers: [buildProvider()],
        providerConfigs: {
          google: {
            providers: {
              google: {
                apiKey: "compat-fixture-key",
                model: "gemini-live-2.5-flash-preview",
                voice: "Puck",
              },
            },
          },
        },
      });

      expect(resolution.providerConfig).toMatchObject({
        apiKey: "compat-fixture-key",
        model: "gemini-live-2.5-flash-preview",
        voice: "Puck",
      });
      expect(resolution.providerConfig).not.toHaveProperty("providers");
    },
  );

  it("normalizes nested config and applies it to the Live setup", async () => {
    const provider = buildGoogleRealtimeVoiceProvider();
    const providerConfig = await provider.resolveConfigAsync?.({
      cfg: { models: { providers: { google: { apiKey: "cfg-key" } } } } as never,
      rawConfig: {
        providers: {
          google: {
            model: "gemini-live-2.5-flash-preview",
            voice: "Puck",
            temperature: 0.3,
            startSensitivity: "low",
            endSensitivity: "low",
            silenceDurationMs: 700,
            activityHandling: "no_interruption",
            turnCoverage: "turn_includes_only_activity",
            automaticActivityDetectionDisabled: false,
            sessionResumption: false,
            contextWindowCompression: false,
          },
        },
      },
    });
    await createBridge({
      providerConfig,
      instructions: "Speak briefly.",
    }).connect();
    expect(createGoogleGenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "cfg-key" }),
    );
    expect(connection()).toMatchObject({
      model: "gemini-live-2.5-flash-preview",
      config: {
        responseModalities: ["AUDIO"],
        temperature: 0.3,
        systemInstruction: "Speak briefly.",
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } } },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        realtimeInputConfig: {
          activityHandling: "NO_INTERRUPTION",
          turnCoverage: "TURN_INCLUDES_ONLY_ACTIVITY",
          automaticActivityDetection: {
            disabled: false,
            startOfSpeechSensitivity: "START_SENSITIVITY_LOW",
            endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
            silenceDurationMs: 700,
          },
        },
      },
    });
    expect(connection().config).not.toHaveProperty("sessionResumption");
    expect(connection().config).not.toHaveProperty("contextWindowCompression");
  });

  it.each([
    [
      undefined,
      { thinkingLevel: "low", thinkingBudget: 8_193, enableAffectiveDialog: true },
      { thinkingLevel: "LOW" },
      undefined,
      false,
    ],
    [
      "gemini-live-2.5-flash-preview",
      { thinkingBudget: -1 },
      { thinkingBudget: -1 },
      "NON_BLOCKING",
      true,
    ],
    [
      "gemini-3.8-live",
      { thinkingLevel: "high", thinkingBudget: 8_193 },
      undefined,
      "NON_BLOCKING",
      true,
    ],
    [
      "models/gemini-3.8-live-extended-thinking",
      { thinkingLevel: "high", thinkingBudget: 8_193 },
      { thinkingLevel: "HIGH" },
      "NON_BLOCKING",
      false,
    ],
  ] as const)(
    "negotiates the consult contract for %s",
    async (model, settings, thinking, behavior, continuing) => {
      const bridge = await connectBridge({
        providerConfig: { model, ...settings },
        tools: [createRealtimeTool(CONSULT)],
        onToolCall: vi.fn(),
        onError,
      });
      expect(bridge.supportsToolResultContinuation).toBe(continuing);
      const params = connection();
      expect(params.model).toBe(model ?? "gemini-3.1-flash-live-preview");
      expect(params.config.thinkingConfig).toEqual(thinking);
      expect(params.config).not.toHaveProperty("enableAffectiveDialog");
      expect(params.config).toMatchObject({
        sessionResumption: {},
        contextWindowCompression: { slidingWindow: {} },
      });
      expect(params.config.tools).toEqual([
        {
          functionDeclarations: [
            {
              ...createRealtimeToolDeclaration(CONSULT),
              ...(behavior ? { behavior } : {}),
            },
          ],
        },
      ]);
      receive({ setupComplete: {} });
      callTool("consult-call", CONSULT, { prompt: "hi" });
      const interim = () =>
        bridge.submitToolResult("consult-call", { status: "working" }, { willContinue: true });
      if (continuing) {
        void interim();
        expect(session.sendToolResponse).toHaveBeenNthCalledWith(1, {
          functionResponses: [
            {
              id: "consult-call",
              name: CONSULT,
              scheduling: "WHEN_IDLE",
              willContinue: true,
              response: { status: "working" },
            },
          ],
        });
      } else {
        expect(interim).toThrow("does not support continuing tool responses");
        expect(session.sendToolResponse).not.toHaveBeenCalled();
        expect(onError).toHaveBeenCalledOnce();
      }
      void bridge.submitToolResult("consult-call", { text: "The meeting starts at 3." });
      expect(session.sendToolResponse).toHaveBeenLastCalledWith({
        functionResponses: [
          {
            id: "consult-call",
            name: CONSULT,
            response: { text: "The meeting starts at 3." },
            ...(continuing ? { scheduling: "WHEN_IDLE" } : {}),
          },
        ],
      });
      expect(session.sendToolResponse).toHaveBeenCalledTimes(continuing ? 2 : 1);
    },
  );

  it("omits invalid sampling, VAD and thinking options before connecting", async () => {
    await createBridge({
      providerConfig: {
        temperature: 0,
        prefixPaddingMs: -1,
        silenceDurationMs: 250.5,
        thinkingBudget: 24_576.5,
      },
    }).connect();
    const config = connection().config;
    expect(config).not.toHaveProperty("temperature");
    expect(config).not.toHaveProperty("realtimeInputConfig");
    expect(config).not.toHaveProperty("thinkingConfig");
  });

  it("mints a single-use constrained browser token with the Talk admission expiry", async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 7, 1, 12, 34, 56, 789);
    vi.setSystemTime(now);
    const result = await buildGoogleRealtimeVoiceProvider().createBrowserSession?.({
      providerConfig: {
        apiKey: "gemini-key",
        model: "gemini-live-2.5-flash-preview",
        voice: "Puck",
        temperature: 0.4,
        prefixPaddingMs: 100,
        silenceDurationMs: 300,
      },
      prefixPaddingMs: 250,
      silenceDurationMs: 650,
      instructions: "Speak briefly.",
      tools: [createRealtimeTool(CONSULT)],
    });
    expect(createGoogleGenAIMock).toHaveBeenCalledWith({
      apiKey: "gemini-key",
      httpOptions: { apiVersion: "v1alpha", timeout: 30_000 },
    });
    expect(createTokenMock).toHaveBeenCalledExactlyOnceWith({
      config: {
        uses: 1,
        expireTime: new Date(now + 30 * 60 * 1000).toISOString(),
        newSessionExpireTime: new Date(now + 60 * 1000).toISOString(),
        liveConnectConstraints: {
          model: "gemini-live-2.5-flash-preview",
          config: expect.objectContaining({
            temperature: 0.4,
            systemInstruction: "Speak briefly.",
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } } },
            realtimeInputConfig: {
              automaticActivityDetection: { prefixPaddingMs: 250, silenceDurationMs: 650 },
            },
            tools: [
              {
                functionDeclarations: [
                  { ...createRealtimeToolDeclaration(CONSULT), behavior: "NON_BLOCKING" },
                ],
              },
            ],
          }),
        },
      },
    });
    expect(result).toMatchObject({
      transport: "provider-websocket",
      protocol: "google-live-bidi",
      clientSecret: "auth_tokens/browser-session",
      expiresAt: now + 60_000,
      initialMessage: { setup: { model: "models/gemini-live-2.5-flash-preview" } },
    });
  });

  it("builds thinking config per model family", () => {
    expect(buildThinkingConfig({}, EXTENDED)).toBeUndefined();
    expect(buildThinkingConfig({ thinkingLevel: "minimal" }, EXTENDED)).toEqual({
      thinkingLevel: "LOW",
    });
    expect(buildThinkingConfig({ thinkingBudget: 4_096 }, EXTENDED)).toEqual({
      thinkingLevel: "MEDIUM",
    });
    expect(buildThinkingConfig({ thinkingBudget: -1 }, EXTENDED)).toBeUndefined();
  });

  it("keeps both transcript roles and interruption across a recovered resumption handle", async () => {
    vi.useFakeTimers();
    const bridge = createBridge({
      providerConfig: { model: LEGACY },
      onTranscript,
      onResponseDone,
      onEvent,
    });
    await bridge.connect();
    receive({
      setupComplete: {},
      sessionResumptionUpdate: { resumable: true, newHandle: "resume-1" },
      serverContent: { inputTranscription: { text: "Before " }, interrupted: true },
    });
    content({ outputTranscription: { text: "Answer " } });
    receive({ sessionResumptionUpdate: { resumable: false } });
    receive({ sessionResumptionUpdate: { resumable: true, newHandle: "resume-2" } });
    receive({ sessionResumptionUpdate: { newHandle: "unconfirmed-handle" } });
    await vi.advanceTimersByTimeAsync(500);
    connection().callbacks.onclose({ code: 1011, reason: "temporary" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(connection().config.sessionResumption).toEqual({ handle: "resume-2" });
    expect(onEvent).not.toHaveBeenCalled();
    expect(onTranscript.mock.calls).toEqual([
      ["user", "Before ", false],
      ["assistant", "Answer ", false],
    ]);
    content({
      inputTranscription: { text: "after" },
      outputTranscription: { text: "continued", finished: true },
      turnComplete: true,
    });
    content({ inputTranscription: { finished: true } });
    expect(finalTranscripts(onTranscript)).toEqual([
      ["assistant", "Answer continued", true],
      ["user", "Before after", true],
    ]);
    expect(onResponseDone.mock.calls).toEqual([[{ status: "cancelled" }]]);
  });

  it("resets transcript, interruption and tool ownership when Google invalidates continuity", async () => {
    vi.useFakeTimers();
    const bridge = createBridge({
      providerConfig: { model: LEGACY },
      onTranscript,
      onEvent,
      onResponseDone,
      onToolCall,
    });
    await bridge.connect();
    receive({
      setupComplete: {},
      sessionResumptionUpdate: { resumable: true, newHandle: "resume-1" },
      serverContent: { inputTranscription: { text: "Old user " }, interrupted: true },
    });
    content({ outputTranscription: { text: "Old assistant " } });
    callTool("call-1", "old_lookup");
    receive({ sessionResumptionUpdate: { resumable: false, newHandle: "invalidated-handle" } });
    expect(onEvent).not.toHaveBeenCalled();
    connection().callbacks.onclose({ code: 1011, reason: "temporary", wasClean: false });
    expect(onEvent.mock.calls).toEqual([
      [{ direction: "client", type: "session.continuity.reset" }],
    ]);
    expect(finalTranscripts(onTranscript)).toEqual([]);
    await vi.advanceTimersByTimeAsync(250);
    expect(connection().config.sessionResumption).toEqual({});
    expect(callOrder(onEvent)).toBeLessThan(callOrder(connectMock, 1));
    callTool("call-1", "new_lookup");
    void bridge.submitToolResult("call-1", { result: "ok" });
    receive({
      setupComplete: {},
      serverContent: {
        inputTranscription: { text: "Fresh user", finished: true },
        outputTranscription: { text: "Fresh assistant", finished: true },
        turnComplete: true,
      },
    });
    expect(onToolCall).toHaveBeenCalledTimes(2);
    expect(session.sendToolResponse).toHaveBeenCalledWith({
      functionResponses: [{ id: "call-1", name: "new_lookup", response: { result: "ok" } }],
    });
    expect(finalTranscripts(onTranscript)).toEqual([
      ["user", "Fresh user", true],
      ["assistant", "Fresh assistant", true],
    ]);
    expect(onResponseDone.mock.calls).toEqual([[{ status: "completed" }]]);
  });

  it.each(["telephony", "pcm"] as const)(
    "converts %s audio at the bridge boundary",
    async (format) => {
      const bridge = await openBridge({
        ...(format === "pcm" ? { audioFormat: PCM } : {}),
        onAudio,
        onTranscript,
      });
      const output = Buffer.alloc(480);
      if (format === "telephony") {
        output.set([0xfb, 0xff]);
      }
      bridge.sendAudio(format === "pcm" ? output : Buffer.from([0xff, 0x00]));
      const sent = session.sendRealtimeInput.mock.calls[0]?.[0]?.audio;
      expect(sent.mimeType).toBe("audio/pcm;rate=16000");
      const pcm = Buffer.from(sent.data, "base64");
      if (format === "pcm") {
        expect(pcm).toHaveLength(320);
      } else {
        expect(Array.from({ length: pcm.length / 2 }, (_, i) => pcm.readInt16LE(i * 2))).toEqual([
          0, -16062, -32124, -32124,
        ]);
      }
      content({
        modelTurn: {
          parts: [
            {
              inlineData: {
                mimeType: "audio/L16;codec=pcm;rate=24000",
                data: output.toString(format === "pcm" ? "base64" : "base64url"),
              },
            },
            { text: "internal reasoning", thought: true },
            { text: "uncorrelated text" },
          ],
        },
      });
      expect(onAudio).toHaveBeenCalledOnce();
      expect(onAudio.mock.calls[0]?.[0]).toBeInstanceOf(Buffer);
      if (format === "pcm") {
        expect(onAudio).toHaveBeenCalledExactlyOnceWith(output);
      } else {
        expect(onAudio.mock.calls[0]?.[0]).toHaveLength(80);
      }
      expect(onTranscript).not.toHaveBeenCalled();
    },
  );

  it("keeps Extended Thinking active across a filler utterance and tool call", async () => {
    await openBridge({
      providerConfig: { model: EXTENDED },
      onResponseDone,
      onToolCall,
      onTranscript,
    });
    content({
      outputTranscription: { text: "Checking now." },
      turnComplete: true,
      interactionStatus: "IN_PROGRESS",
    });
    expect(onTranscript.mock.calls).toEqual([
      ["assistant", "Checking now.", false],
      ["assistant", "Checking now.", true],
    ]);
    expect(onResponseDone).not.toHaveBeenCalled();

    callTool("consult-call", CONSULT, { prompt: "hi" });
    expect(onToolCall).toHaveBeenCalledOnce();
    expect(onResponseDone).not.toHaveBeenCalled();

    content({
      outputTranscription: { text: "The answer is 42." },
      turnComplete: true,
      interactionStatus: "IDLE",
    });
    expect(onTranscript).toHaveBeenLastCalledWith("assistant", "The answer is 42.", true);
    expect(onResponseDone.mock.calls).toEqual([[{ status: "completed" }]]);
  });

  it("interrupts Gemini 3.8 Live Extended Thinking output with a client turn on barge-in", async () => {
    const bridge = await openBridge({
      onClearAudio,
      onResponseDone,
      providerConfig: { model: EXTENDED },
    });
    expect(buildGoogleRealtimeVoiceProvider().capabilities?.handlesInputAudioBargeIn).toBe(true);
    bridge.handleBargeIn?.({ audioPlaybackActive: false });
    expect(session.sendClientContent).not.toHaveBeenCalled();

    bridge.handleBargeIn?.({ audioPlaybackActive: true });
    expect(session.sendClientContent).toHaveBeenCalledWith({
      turns: [
        {
          role: "user",
          parts: [{ text: "[You were interrupted. Stop speaking and wait silently.]" }],
        },
      ],
      turnComplete: true,
    });
    receive({
      serverContent: { interrupted: true, turnComplete: true, interactionStatus: "IN_PROGRESS" },
    });
    expect(onClearAudio).toHaveBeenCalledWith("barge-in");
    expect(onResponseDone.mock.calls).toEqual([[{ status: "cancelled" }]]);
  });

  it("finalizes Gemini 3.8 input transcriptions without a finished flag", async () => {
    await openBridge({ providerConfig: { model: "gemini-3.8-live" }, onTranscript });
    for (const [question, answer] of [
      ["What color is the sky?", "Blue."],
      ["Name a yellow fruit.", "A banana."],
    ]) {
      content({ inputTranscription: { text: question } });
      expect(onTranscript).toHaveBeenLastCalledWith("user", question, true);
      content({ outputTranscription: { text: answer } });
      content({ generationComplete: true });
      content({ turnComplete: true, interactionStatus: "IDLE" });
    }

    expect(finalTranscripts(onTranscript)).toEqual([
      ["user", "What color is the sky?", true],
      ["assistant", "Blue.", true],
      ["user", "Name a yellow fruit.", true],
      ["assistant", "A banana.", true],
    ]);
  });

  it("omits tool names that Google Live cannot accept", async () => {
    await connectBridge({
      tools: [
        createRealtimeTool("_lookup"),
        createRealtimeTool("bad/name"),
        createMalformedToolName(42),
        createUnreadableToolName(),
      ],
    });
    expect(connection().config.tools).toEqual([
      { functionDeclarations: [createRealtimeToolDeclaration("_lookup")] },
    ]);
  });

  it("disposes a late session and ignores stale callbacks after reconnecting", async () => {
    vi.useFakeTimers();
    const pendingSession = createDeferred<MockGoogleLiveSession>();
    const lateSession = mockSession();
    const replacementSession = mockSession();
    connectMock
      .mockReturnValueOnce(pendingSession.promise)
      .mockResolvedValueOnce(replacementSession);
    const bridge = createBridge({ onReady, onError });

    const cancelledConnect = bridge.connect();
    const staleCallbacks = connection().callbacks;
    activate(staleCallbacks, {});
    expect(bridge.isConnected()).toBe(false);
    expect(onReady).not.toHaveBeenCalled();
    void bridge.close();
    await cancelledConnect;

    await bridge.connect();
    const activeCallbacks = connection().callbacks;
    activate(activeCallbacks, {});
    expect(bridge.isConnected()).toBe(true);
    expect(onReady).toHaveBeenCalledTimes(1);

    activate(staleCallbacks, {});
    staleCallbacks.onerror({ message: "stale error" });
    staleCallbacks.onclose({ code: 1011, reason: "stale close" });
    await vi.advanceTimersByTimeAsync(250);

    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(bridge.isConnected()).toBe(true);
    expect(replacementSession.close).not.toHaveBeenCalled();

    pendingSession.resolve(lateSession);
    await vi.waitFor(() => {
      expect(lateSession.close).toHaveBeenCalledTimes(1);
    });
    expect(bridge.isConnected()).toBe(true);

    void bridge.close();
    void bridge.close();
    expect(replacementSession.close).toHaveBeenCalledTimes(1);
  });

  it("preserves tool ownership while reusing a resumption handle", async () => {
    vi.useFakeTimers();
    const bridge = await connectBridge({ onError, onToolCall });
    const firstSession = connection().callbacks;
    firstSession.onmessage({
      sessionResumptionUpdate: { resumable: true, newHandle: "resume-1" },
      toolCall: {
        functionCalls: [{ id: "call-1", name: "lookup", args: { query: "before" } }],
      },
    });
    expect(onToolCall).toHaveBeenCalledExactlyOnceWith({
      itemId: "call-1",
      callId: "call-1",
      name: "lookup",
      args: { query: "before" },
    });
    firstSession.onclose({ code: 1011, reason: "temporary" });

    onError.mockClear();
    expect(() => bridge.submitToolResult("call-1", { value: 1n })).toThrow(/serializ/i);
    expect(onError).toHaveBeenCalledOnce();

    void bridge.submitToolResult("call-1", { result: "ok" });
    expect(session.sendToolResponse).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);

    const resumedSession = connection().callbacks;
    callTool("call-1", "different", { query: "replay" });
    activate(resumedSession, {});

    expect(connection().config.sessionResumption).toEqual({ handle: "resume-1" });
    expect(onToolCall).toHaveBeenCalledOnce();
    resumedSession.onmessage({
      toolCall: { functionCalls: [{ id: "call-1", name: "lookup", args: {} }] },
    });
    expect(onToolCall).toHaveBeenCalledOnce();
    expect(session.sendToolResponse).toHaveBeenCalledWith({
      functionResponses: [{ id: "call-1", name: "lookup", response: { result: "ok" } }],
    });
  });

  it("fails closed when resumable tool responses exceed the reconnect buffer", async () => {
    vi.useFakeTimers();
    const bridge = await connectBridge({
      onToolCall: vi.fn(),
      onError,
      onClose,
    });
    disconnectWithTools();
    onError.mockClear();

    expect(() => bridge.submitToolResult("call-1", { result: "x".repeat(1024 * 1024) })).toThrow(
      "Google Live reconnect tool-response buffer limit exceeded",
    );

    expect(onError).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith("error");
    expect(session.sendToolResponse).not.toHaveBeenCalled();
  });

  it("drops queued reconnect responses when the resumed session cancels their call", async () => {
    vi.useFakeTimers();
    const bridge = await connectBridge({
      onToolCall: vi.fn(),
      onEvent,
    });
    disconnectWithTools([
      { id: "call-1", name: "lookup", args: {} },
      { id: "call-2", name: "lookup", args: {} },
    ]);
    await vi.advanceTimersByTimeAsync(250);

    const resumedSession = connection().callbacks;
    void bridge.submitToolResult("call-1", { result: "stale" });
    expect(session.sendToolResponse).not.toHaveBeenCalled();
    resumedSession.onopen();
    resumedSession.onmessage({
      setupComplete: {},
      toolCallCancellation: { ids: ["call-1", "call-2"] },
    });

    expect(session.sendToolResponse).not.toHaveBeenCalled();
    void bridge.submitToolResult("call-2", { result: "late" });
    expect(session.sendToolResponse).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledWith({
      direction: "server",
      type: "tool.call.cancelled",
      itemId: "call-1",
    });
  });

  it("flushes pending transcripts before closing after reconnect failures", async () => {
    vi.useFakeTimers();
    await connectBridge({
      providerConfig: { model: LEGACY },
      onClose,
      onTranscript,
    });
    const firstSession = connection().callbacks;
    firstSession.onmessage({
      setupComplete: {},
      sessionResumptionUpdate: { resumable: true, newHandle: "resume-1" },
      serverContent: { inputTranscription: { text: "Last words" } },
    });
    rejectReconnects();
    firstSession.onclose({ code: 1011, reason: "temporary" });

    await vi.advanceTimersByTimeAsync(1_750);

    expect(onTranscript.mock.calls.at(-1)).toEqual(["user", "Last words", true]);
    expect(onClose).toHaveBeenCalledWith("error");
    expect(onTranscript.mock.invocationCallOrder.at(-1)).toBeLessThan(
      onClose.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it("rearms continuity reset after pre-return setup selects a fresh session", async () => {
    vi.useFakeTimers();
    const pendingSession = createDeferred<MockGoogleLiveSession>();
    const freshSession = mockSession();
    connectMock
      .mockReturnValueOnce(Promise.resolve(session))
      .mockReturnValueOnce(pendingSession.promise);
    const bridge = await connectBridge({
      providerConfig: { model: LEGACY, sessionResumption: false },
      onEvent,
      onReady,
      onTranscript,
    });
    const firstCallbacks = connection().callbacks;
    activate(firstCallbacks, {});
    firstCallbacks.onclose({ code: 1011, reason: "temporary" });
    const queuedAudio = Buffer.from([0x7f]);
    bridge.sendAudio(queuedAudio);
    await vi.advanceTimersByTimeAsync(250);

    const joiningConnect = bridge.connect();
    const secondJoiningConnect = bridge.connect();
    expect(connectMock).toHaveBeenCalledTimes(2);
    const freshCallbacks = connection().callbacks;
    expect(onEvent).toHaveBeenCalledTimes(1);
    freshCallbacks.onopen();
    freshCallbacks.onmessage({
      setupComplete: {},
      serverContent: { inputTranscription: { text: "Fresh partial " } },
    });
    expect(onEvent.mock.calls.map(([event]) => event.type)).toEqual([
      "session.continuity.reset",
      "session.created",
    ]);
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(freshSession.sendRealtimeInput).not.toHaveBeenCalled();

    pendingSession.resolve(freshSession);
    expect(bridge.isConnected()).toBe(false);
    await Promise.all([joiningConnect, secondJoiningConnect]);
    expect(onReady).toHaveBeenCalledTimes(2);
    expect(bridge.isConnected()).toBe(true);
    freshCallbacks.onmessage({ setupComplete: {} });
    expect(onReady).toHaveBeenCalledTimes(2);
    expect(callOrder(onEvent, 1)).toBeLessThan(callOrder(freshSession.sendRealtimeInput));
    expect(callOrder(freshSession.sendRealtimeInput)).toBeLessThan(callOrder(onReady, 1));
    expect(freshSession.sendRealtimeInput).toHaveBeenCalledOnce();
    freshCallbacks.onclose({ code: 1011, reason: "temporary again" });
    await vi.advanceTimersByTimeAsync(250);

    expect(onEvent.mock.calls.map(([event]) => event.type)).toEqual([
      "session.continuity.reset",
      "session.created",
      "session.continuity.reset",
    ]);
    content({ inputTranscription: { text: "Next", finished: true } });
    expect(finalTranscripts(onTranscript)).toEqual([["user", "Next", true]]);
  });

  it("copies and bounds pending audio by aggregate bytes before activation", async () => {
    const bridge = createBridge({ audioFormat: PCM });
    const backing = Buffer.alloc(2 * 1024 * 1024);
    const firstChunk = backing.subarray(0, 512 * 1024);
    firstChunk.writeInt16LE(513);
    const expectedFirstSample = resamplePcm(Buffer.from(firstChunk), 24_000, 16_000).readInt16LE(0);

    bridge.sendAudio(firstChunk);
    bridge.sendAudio(Buffer.alloc(512 * 1024, 0x7f));
    bridge.sendAudio(Buffer.from([0x01]));
    firstChunk.fill(0);

    await bridge.connect();
    activate();

    expect(session.sendRealtimeInput).toHaveBeenCalledTimes(2);
    const firstAudio = session.sendRealtimeInput.mock.calls[0]?.[0]?.audio as
      | { data?: unknown }
      | undefined;
    expect(Buffer.from(String(firstAudio?.data), "base64").readInt16LE(0)).toBe(
      expectedFirstSample,
    );
  });

  it("bounds pending audio by chunk count before activation", async () => {
    const bridge = createBridge({ audioFormat: PCM });

    for (let index = 0; index < 321; index += 1) {
      bridge.sendAudio(Buffer.alloc(2, index & 0xff));
    }

    await bridge.connect();
    activate();

    expect(session.sendRealtimeInput).toHaveBeenCalledTimes(320);
  });

  it("drops reconnect audio on terminal exhaustion until an explicit reconnect owns admission", async () => {
    vi.useFakeTimers();
    const reconnectedSession = mockSession();
    const bridge = await connectBridge({
      audioFormat: PCM,
      onClose,
      onEvent,
    });
    const firstSession = connection().callbacks;
    activate(firstSession, { sessionId: "session-1" });
    rejectReconnects().mockResolvedValueOnce(reconnectedSession);
    firstSession.onclose({ code: 1011, reason: "temporary" });
    bridge.sendAudio(Buffer.from([0x01, 0x00]));

    await vi.advanceTimersByTimeAsync(1_750);
    bridge.sendAudio(Buffer.from([0x02, 0x00]));

    expect(onEvent.mock.calls).toEqual([
      [{ direction: "client", type: "session.continuity.reset" }],
    ]);
    expect(onClose).toHaveBeenCalledExactlyOnceWith("error");

    await bridge.connect();
    const reconnected = connection().callbacks;
    activate(reconnected, { sessionId: "session-2" });
    bridge.sendAudio(Buffer.alloc(480, 0x03));

    expect(reconnectedSession.sendRealtimeInput).toHaveBeenCalledOnce();
    const sent = reconnectedSession.sendRealtimeInput.mock.calls[0]?.[0]?.audio as
      | { data?: unknown }
      | undefined;
    expect(sent?.data).toBeTypeOf("string");
    await bridge.close();
  });

  it("closes the session when the ready callback rejects activation", async () => {
    const pendingSession = createDeferred<MockGoogleLiveSession>();
    const connectedSession = mockSession();
    connectMock.mockReturnValueOnce(pendingSession.promise);
    const bridge = createBridge({
      onReady: () => {
        throw new Error("ready callback failed");
      },
    });
    const connect = bridge.connect();
    activate();
    pendingSession.resolve(connectedSession);

    await expect(connect).rejects.toThrow("ready callback failed");
    expect(connectedSession.close).toHaveBeenCalledTimes(1);
    expect(bridge.isConnected()).toBe(false);
  });

  it.each([undefined, EXTENDED])("handles sustained telephony silence for %s", async (model) => {
    const bridge = await openBridge({ providerConfig: { model, silenceDurationMs: 60 } });

    const silence20ms = Buffer.alloc(160, 0xff);
    if (model === EXTENDED) {
      for (let frame = 0; frame < 10; frame += 1) {
        bridge.sendAudio(silence20ms);
      }
      expect(session.sendRealtimeInput).not.toHaveBeenCalledWith({ audioStreamEnd: true });
      expect(session.sendRealtimeInput).toHaveBeenCalledTimes(10);
      return;
    }
    bridge.sendAudio(silence20ms);
    bridge.sendAudio(silence20ms);
    bridge.sendAudio(silence20ms);

    expect(session.sendRealtimeInput).toHaveBeenCalledWith({ audioStreamEnd: true });

    const callsAfterStreamEnd = session.sendRealtimeInput.mock.calls.length;
    bridge.sendAudio(silence20ms);
    expect(session.sendRealtimeInput).toHaveBeenCalledTimes(callsAfterStreamEnd);

    session.sendRealtimeInput.mockClear();
    bridge.sendAudio(Buffer.alloc(160, 0x7f));
    bridge.sendAudio(silence20ms);
    bridge.sendAudio(silence20ms);
    bridge.sendAudio(silence20ms);

    expect(session.sendRealtimeInput).toHaveBeenCalledWith({ audioStreamEnd: true });
  });

  it.each([
    [undefined, "realtime"],
    ["gemini-live-2.5-flash-preview", "ordered"],
  ])("sends text through the %s model's input protocol", async (model, protocol) => {
    const bridge = await openBridge({ providerConfig: { model } });
    bridge.sendUserMessage?.(" Say hello. ");
    if (protocol === "realtime") {
      expect(session.sendRealtimeInput).toHaveBeenCalledWith({ text: "Say hello." });
      expect(session.sendClientContent).not.toHaveBeenCalled();
    } else {
      expect(session.sendClientContent).toHaveBeenCalledWith({
        turns: [{ role: "user", parts: [{ text: "Say hello." }] }],
        turnComplete: true,
      });
    }
  });
  it("terminates the session for malformed output audio", async () => {
    const data = "not-base64!";
    const bridge = await connectBridge({
      audioFormat: PCM,
      onAudio,
      onError,
      onClose,
      onTranscript,
    });
    receive({
      setupComplete: { sessionId: "session-1" },
      serverContent: {
        outputTranscription: { text: "finalize me" },
        modelTurn: {
          parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data } }],
        },
      },
    });

    expect(onAudio).not.toHaveBeenCalled();
    expect(onTranscript.mock.calls).toEqual([
      ["assistant", "finalize me", false],
      ["assistant", "finalize me", true],
    ]);
    expectError(onError, "Google Live stream returned malformed base64 audio data");
    expect(onClose).toHaveBeenCalledWith("error");
    expect(session.close).toHaveBeenCalledTimes(1);
    await expect(bridge.connect()).rejects.toThrow(
      "Google Live stream returned malformed base64 audio data",
    );
  });

  it("terminates and clears a runaway transcript stream at the UTF-8 byte limit", async () => {
    const bridge = await connectBridge({
      providerConfig: { model: LEGACY },
      onError,
      onClose,
      onTranscript,
    });
    const callbacks = connection().callbacks;
    const transcriptChunk = "€".repeat(Math.floor((256 * 1024) / 3));
    callbacks.onmessage({ serverContent: { inputTranscription: { text: transcriptChunk } } });
    callbacks.onmessage({ serverContent: { inputTranscription: { text: "€" } } });
    callbacks.onmessage({ serverContent: { inputTranscription: { text: "late fragment" } } });
    callbacks.onclose({ code: 1000, reason: "late clean close", wasClean: true });

    expect(onTranscript).toHaveBeenCalledOnce();
    expect(onTranscript.mock.calls.at(-1)).toEqual(["user", transcriptChunk, false]);
    expect(onError).toHaveBeenCalledTimes(1);
    expectError(onError, "Google Live transcript exceeded the 256 KiB UTF-8 pending buffer limit");
    expect(finalTranscripts(onTranscript)).toEqual([]);
    expect(onClose).toHaveBeenCalledExactlyOnceWith("error");
    expect(session.close).toHaveBeenCalledTimes(1);
    await expect(bridge.connect()).rejects.toThrow(
      "Google Live transcript exceeded the 256 KiB UTF-8 pending buffer limit",
    );
  });

  it("finalizes assistant turns without finalizing independently ordered 2.5 input", async () => {
    const bridge = await connectBridge({
      providerConfig: { model: LEGACY },
      onTranscript,
    });
    content({ inputTranscription: { text: "Earlier question. " } });
    content({ outputTranscription: { text: "Interrupted response " } });
    content({ interrupted: true });
    content({ turnComplete: true });
    content({
      inputTranscription: { text: "New question" },
      outputTranscription: { text: "ending" },
      turnComplete: true,
    });

    expect(finalTranscripts(onTranscript)).toEqual([
      ["assistant", "Interrupted response", true],
      ["assistant", "ending", true],
    ]);

    void bridge.close();
    expect(finalTranscripts(onTranscript)).toEqual([
      ["assistant", "Interrupted response", true],
      ["assistant", "ending", true],
      ["user", "Earlier question. New question", true],
    ]);
  });

  it("closes the Live session when the final transcript callback throws", async () => {
    const callbackError = new Error("transcript persistence failed");
    const bridge = createBridge({
      providerConfig: { model: LEGACY },
      onError,
      onTranscript: vi.fn((_role, _text, isFinal) => {
        if (isFinal) {
          throw callbackError;
        }
      }),
    });

    await bridge.connect();
    content({ inputTranscription: { text: "Last words" } });

    expect(() => bridge.close()).not.toThrow();
    expect(onError).toHaveBeenCalledWith(callbackError);
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it("fails closed when Google exceeds the tool-call session limit", async () => {
    await connectBridge({ onToolCall, onError, onClose });
    receive({
      toolCall: {
        functionCalls: Array.from({ length: 1_025 }, (_, index) => ({
          id: `call-${index}`,
          name: "lookup",
          args: {},
        })),
      },
    });

    expect(onToolCall).toHaveBeenCalledTimes(1_024);
    expectError(onError, "Google Live tool-call session limit exceeded");
    expect(session.close).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith("error");
  });

  it("does not send malformed Live API tool responses without a matching call name", async () => {
    const bridge = await connectBridge();

    expect(() => bridge.submitToolResult("missing-call", { result: "ok" })).toThrow(
      "Google Live function response is missing a matching function call for missing-call",
    );

    expect(session.sendToolResponse).not.toHaveBeenCalled();
  });

  it.each([
    ["undefined", (): undefined => undefined],
    ["omitted custom serialization", () => ({ toJSON: () => undefined })],
  ] as const)(
    "rejects %s Google Live tool results while keeping the call retryable",
    async (_label, create) => {
      const bridge = createBridge({
        onError,
        onToolCall: vi.fn(),
      });
      await bridge.connect();
      receive({
        setupComplete: { sessionId: "session-1" },
        toolCall: { functionCalls: [{ id: "call-1", name: "lookup", args: {} }] },
      });

      expect(() => bridge.submitToolResult("call-1", create())).toThrow(/serializ/i);
      expect(onError).toHaveBeenCalledOnce();
      expect(session.sendToolResponse).not.toHaveBeenCalled();

      await bridge.submitToolResult("call-1", { recovered: true });

      expect(session.sendToolResponse).toHaveBeenCalledExactlyOnceWith({
        functionResponses: [{ id: "call-1", name: "lookup", response: { recovered: true } }],
      });
    },
  );

  it("preserves valid Google Live tool results and nested serialization keys", async () => {
    const bridge = createBridge({
      onToolCall: vi.fn(),
    });
    const objectSerialization = vi.fn((key: string) => ({ key }));
    const arraySerialization = vi.fn((key: string) => [key]);
    const customArray: unknown[] & { toJSON?: (key: string) => string[] } = [];
    customArray.toJSON = arraySerialization;
    const values: unknown[] = [null, "text", { toJSON: objectSerialization }, customArray];
    await bridge.connect();
    receive({
      setupComplete: { sessionId: "session-1" },
      toolCall: {
        functionCalls: values.map((_, index) => ({
          id: `call-${index}`,
          name: "lookup",
          args: {},
        })),
      },
    });

    for (const [index, result] of values.entries()) {
      await bridge.submitToolResult(`call-${index}`, result);
    }

    expect(
      session.sendToolResponse.mock.calls.map(([request]) => request.functionResponses[0].response),
    ).toEqual([{ output: null }, { output: "text" }, { key: "response" }, { output: ["output"] }]);
    expect(objectSerialization).toHaveBeenCalledExactlyOnceWith("response");
    expect(arraySerialization).toHaveBeenCalledExactlyOnceWith("output");
  });

  it("reports Google Live tool response send failures without losing the call name", async () => {
    const bridge = await connectBridge({ onError });
    receive({ setupComplete: {} });
    callTool("call-1", "lookup", { query: "hi" });

    const sendError = new Error("SDK send failed");
    session.sendToolResponse.mockImplementationOnce(() => {
      throw sendError;
    });

    expect(() => bridge.submitToolResult("call-1", ["retryable"])).toThrow(sendError);

    expect(onError).toHaveBeenCalledExactlyOnceWith(sendError);

    void bridge.submitToolResult("call-1", { result: "ok" });

    expect(session.sendToolResponse).toHaveBeenLastCalledWith({
      functionResponses: [{ id: "call-1", name: "lookup", response: { result: "ok" } }],
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
