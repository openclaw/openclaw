import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  resamplePcm,
  type RealtimeVoiceTool,
} from "openclaw/plugin-sdk/realtime-voice";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildThinkingConfig } from "./realtime-voice-model-contract.js";
import { buildGoogleRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const CONSULT = "openclaw_agent_consult";
const LEGACY = "gemini-2.5-flash-native-audio-preview-12-2025";
const EXTENDED = "gemini-3.8-live-extended-thinking";

type MockGoogleLiveSession = ReturnType<typeof createMockGoogleLiveSession>;
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

function lastConnectParams(): MockGoogleLiveConnectParams {
  const params = connectMock.mock.calls.at(-1)?.[0];
  if (!params) {
    throw new Error("expected google live connect call");
  }
  return params;
}
function receive(message: Record<string, unknown>) {
  lastConnectParams().callbacks.onmessage(message);
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
  lastConnectParams().callbacks.onclose({ code: 1011, reason: "temporary" });
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
function createMockGoogleLiveSession() {
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
function createGoogleLiveBridge(params: Partial<GoogleLiveBridgeParams> = {}) {
  const { providerConfig, ...callbacks } = params;
  return buildGoogleRealtimeVoiceProvider().createBridge({
    providerConfig: { apiKey: "gemini-key", ...providerConfig },
    onAudio: vi.fn(),
    onClearAudio: vi.fn(),
    ...callbacks,
  });
}
async function connectBridge(params: Partial<GoogleLiveBridgeParams> = {}) {
  const bridge = createGoogleLiveBridge(params);
  await bridge.connect();
  return bridge;
}
function activate() {
  lastConnectParams().callbacks.onopen();
  receive({ setupComplete: {} });
}
async function openConfiguredBridge(params: Partial<GoogleLiveBridgeParams> = {}) {
  const bridge = await connectBridge(params);
  activate();
  return bridge;
}

describe("buildGoogleRealtimeVoiceProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("normalizes nested config and applies it to the Live setup", async () => {
    const provider = buildGoogleRealtimeVoiceProvider();
    const providerConfig = provider.resolveConfig?.({
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
    await createGoogleLiveBridge({
      providerConfig,
      instructions: "Speak briefly.",
    }).connect();
    expect(createGoogleGenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "cfg-key" }),
    );
    expect(lastConnectParams()).toMatchObject({
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
    expect(lastConnectParams().config).not.toHaveProperty("sessionResumption");
    expect(lastConnectParams().config).not.toHaveProperty("contextWindowCompression");
  });

  it.each([
    {
      model: undefined,
      settings: { thinkingLevel: "low", thinkingBudget: 8_193, enableAffectiveDialog: true },
      thinking: { thinkingLevel: "LOW" },
      behavior: undefined,
      continuing: false,
    },
    {
      model: "gemini-live-2.5-flash-preview",
      settings: { thinkingBudget: -1 },
      thinking: { thinkingBudget: -1 },
      behavior: "NON_BLOCKING",
      continuing: true,
    },
    {
      model: "gemini-3.8-live",
      settings: { thinkingLevel: "high", thinkingBudget: 8_193 },
      thinking: undefined,
      behavior: "NON_BLOCKING",
      continuing: true,
    },
    {
      model: "models/gemini-3.8-live-extended-thinking",
      settings: { thinkingLevel: "high", thinkingBudget: 8_193 },
      thinking: { thinkingLevel: "HIGH" },
      behavior: "NON_BLOCKING",
      continuing: false,
    },
  ])(
    "negotiates the consult contract for $model",
    async ({ model, settings, thinking, behavior, continuing }) => {
      const onError = vi.fn();
      const bridge = await connectBridge({
        providerConfig: { model, ...settings },
        tools: [createRealtimeTool(CONSULT)],
        onToolCall: vi.fn(),
        onError,
      });
      expect(bridge.supportsToolResultContinuation).toBe(continuing);
      const params = lastConnectParams();
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
    await createGoogleLiveBridge({
      providerConfig: {
        temperature: 0,
        prefixPaddingMs: -1,
        silenceDurationMs: 250.5,
        thinkingBudget: 24_576.5,
      },
    }).connect();
    const config = lastConnectParams().config;
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

  it("rejects browser expiry outside the Date range before minting a token", async () => {
    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_001);
    await expect(
      buildGoogleRealtimeVoiceProvider().createBrowserSession?.({
        providerConfig: { apiKey: "gemini-key" },
      }),
    ).rejects.toThrow("Google realtime browser session expiry is outside the supported Date range");
    expect(createTokenMock).not.toHaveBeenCalled();
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
    const onTranscript = vi.fn();
    const onResponseDone = vi.fn();
    const onEvent = vi.fn();
    const bridge = createGoogleLiveBridge({
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
    lastConnectParams().callbacks.onclose({ code: 1011, reason: "temporary" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(lastConnectParams().config.sessionResumption).toEqual({ handle: "resume-2" });
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
    expect(onTranscript.mock.calls.filter((call) => call[2] === true)).toEqual([
      ["assistant", "Answer continued", true],
      ["user", "Before after", true],
    ]);
    expect(onResponseDone.mock.calls).toEqual([[{ status: "cancelled" }]]);
  });

  it("resets transcript, interruption and tool ownership when Google invalidates continuity", async () => {
    vi.useFakeTimers();
    const onTranscript = vi.fn(),
      onEvent = vi.fn(),
      onResponseDone = vi.fn(),
      onToolCall = vi.fn();
    const bridge = createGoogleLiveBridge({
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
    lastConnectParams().callbacks.onclose({ code: 1011, reason: "temporary", wasClean: false });
    expect(onEvent.mock.calls).toEqual([
      [{ direction: "client", type: "session.continuity.reset" }],
    ]);
    expect(onTranscript.mock.calls.filter((call) => call[2] === true)).toEqual([]);
    await vi.advanceTimersByTimeAsync(250);
    expect(lastConnectParams().config.sessionResumption).toEqual({});
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
    expect(onTranscript.mock.calls.filter((call) => call[2] === true)).toEqual([
      ["user", "Fresh user", true],
      ["assistant", "Fresh assistant", true],
    ]);
    expect(onResponseDone.mock.calls).toEqual([[{ status: "completed" }]]);
  });

  it("converts telephony input and Google PCM output at the bridge boundary", async () => {
    const onAudio = vi.fn();
    const bridge = await openConfiguredBridge({ onAudio });
    bridge.sendAudio(Buffer.from([0xff, 0x00]));
    const sent = session.sendRealtimeInput.mock.calls[0]?.[0]?.audio;
    expect(sent.mimeType).toBe("audio/pcm;rate=16000");
    const pcm = Buffer.from(sent.data, "base64");
    expect(Array.from({ length: pcm.length / 2 }, (_, i) => pcm.readInt16LE(i * 2))).toEqual([
      0, -16062, -32124, -32124,
    ]);
    const output = Buffer.alloc(480);
    output.set([0xfb, 0xff]);
    content({
      modelTurn: {
        parts: [
          {
            inlineData: {
              mimeType: "audio/L16;codec=pcm;rate=24000",
              data: output.toString("base64url"),
            },
          },
        ],
      },
    });
    expect(onAudio).toHaveBeenCalledOnce();
    expect(onAudio.mock.calls[0]?.[0]).toBeInstanceOf(Buffer);
    expect(onAudio.mock.calls[0]?.[0]).toHaveLength(80);
  });

  it("preserves PCM output and resamples PCM input without a mu-law hop", async () => {
    const onAudio = vi.fn(),
      onTranscript = vi.fn();
    const bridge = await openConfiguredBridge({
      audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      onAudio,
      onTranscript,
    });
    const output = Buffer.alloc(480);
    bridge.sendAudio(output);
    const sent = session.sendRealtimeInput.mock.calls[0]?.[0]?.audio;
    expect(sent.mimeType).toBe("audio/pcm;rate=16000");
    expect(Buffer.from(sent.data, "base64")).toHaveLength(320);
    content({
      modelTurn: {
        parts: [
          {
            inlineData: {
              mimeType: "audio/L16;codec=pcm;rate=24000",
              data: output.toString("base64"),
            },
          },
          { text: "internal reasoning", thought: true },
          { text: "uncorrelated text" },
        ],
      },
    });
    expect(onAudio).toHaveBeenCalledExactlyOnceWith(output);
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("keeps Extended Thinking active across a filler utterance and tool call", async () => {
    const onResponseDone = vi.fn();
    const onToolCall = vi.fn();
    const onTranscript = vi.fn();
    await openConfiguredBridge({
      providerConfig: { model: EXTENDED },
      onResponseDone,
      onToolCall,
      onTranscript,
    });
    const callbacks = lastConnectParams().callbacks;

    callbacks.onmessage({
      serverContent: {
        outputTranscription: { text: "Checking now." },
        turnComplete: true,
        interactionStatus: "IN_PROGRESS",
      },
    });
    expect(onTranscript.mock.calls).toEqual([
      ["assistant", "Checking now.", false],
      ["assistant", "Checking now.", true],
    ]);
    expect(onResponseDone).not.toHaveBeenCalled();

    callbacks.onmessage({
      toolCall: {
        functionCalls: [{ id: "consult-call", name: CONSULT, args: { prompt: "hi" } }],
      },
    });
    expect(onToolCall).toHaveBeenCalledOnce();
    expect(onResponseDone).not.toHaveBeenCalled();

    callbacks.onmessage({
      serverContent: {
        outputTranscription: { text: "The answer is 42." },
        turnComplete: true,
        interactionStatus: "IDLE",
      },
    });
    expect(onTranscript).toHaveBeenLastCalledWith("assistant", "The answer is 42.", true);
    expect(onResponseDone.mock.calls).toEqual([[{ status: "completed" }]]);
  });

  it("interrupts Gemini 3.8 Live Extended Thinking output with a client turn on barge-in", async () => {
    const onClearAudio = vi.fn();
    const onResponseDone = vi.fn();
    const bridge = await openConfiguredBridge({
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
    const onTranscript = vi.fn();
    await openConfiguredBridge({ providerConfig: { model: "gemini-3.8-live" }, onTranscript });
    const onmessage = lastConnectParams().callbacks.onmessage;

    for (const [question, answer] of [
      ["What color is the sky?", "Blue."],
      ["Name a yellow fruit.", "A banana."],
    ]) {
      onmessage({ serverContent: { inputTranscription: { text: question } } });
      expect(onTranscript).toHaveBeenLastCalledWith("user", question, true);
      onmessage({ serverContent: { outputTranscription: { text: answer } } });
      onmessage({ serverContent: { generationComplete: true } });
      onmessage({ serverContent: { turnComplete: true, interactionStatus: "IDLE" } });
    }

    expect(onTranscript.mock.calls.filter((call) => call[2] === true)).toEqual([
      ["user", "What color is the sky?", true],
      ["assistant", "Blue.", true],
      ["user", "Name a yellow fruit.", true],
      ["assistant", "A banana.", true],
    ]);
  });

  it("keeps forwarding Gemini 3.8 silence without ending the audio stream", async () => {
    const bridge = await openConfiguredBridge({
      providerConfig: { model: EXTENDED, silenceDurationMs: 60 },
    });

    const silence20ms = Buffer.alloc(160, 0xff);
    for (let frame = 0; frame < 10; frame += 1) {
      bridge.sendAudio(silence20ms);
    }

    expect(session.sendRealtimeInput).not.toHaveBeenCalledWith({ audioStreamEnd: true });
    expect(session.sendRealtimeInput).toHaveBeenCalledTimes(10);
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
    expect(lastConnectParams().config.tools).toEqual([
      { functionDeclarations: [createRealtimeToolDeclaration("_lookup")] },
    ]);
  });

  it("disposes a late session and ignores stale callbacks after reconnecting", async () => {
    vi.useFakeTimers();
    const pendingSession = createDeferred<MockGoogleLiveSession>();
    const lateSession = createMockGoogleLiveSession();
    const replacementSession = createMockGoogleLiveSession();
    connectMock
      .mockReturnValueOnce(pendingSession.promise)
      .mockResolvedValueOnce(replacementSession);
    const onReady = vi.fn();
    const onError = vi.fn();
    const bridge = createGoogleLiveBridge({ onReady, onError });

    const cancelledConnect = bridge.connect();
    const staleCallbacks = lastConnectParams().callbacks;
    staleCallbacks.onopen();
    staleCallbacks.onmessage({ setupComplete: {} });
    expect(bridge.isConnected()).toBe(false);
    expect(onReady).not.toHaveBeenCalled();
    void bridge.close();
    await cancelledConnect;

    await bridge.connect();
    const activeCallbacks = lastConnectParams().callbacks;
    activeCallbacks.onopen();
    activeCallbacks.onmessage({ setupComplete: {} });
    expect(bridge.isConnected()).toBe(true);
    expect(onReady).toHaveBeenCalledTimes(1);

    staleCallbacks.onopen();
    staleCallbacks.onmessage({ setupComplete: {} });
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
    const onError = vi.fn();
    const onToolCall = vi.fn();
    const bridge = await connectBridge({ onError, onToolCall });
    const firstSession = lastConnectParams().callbacks;
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

    const resumedSession = lastConnectParams().callbacks;
    callTool("call-1", "different", { query: "replay" });
    resumedSession.onopen();
    resumedSession.onmessage({ setupComplete: {} });

    expect(lastConnectParams().config.sessionResumption).toEqual({ handle: "resume-1" });
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
    const onError = vi.fn();
    const onClose = vi.fn();
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
    const onEvent = vi.fn();
    const bridge = await connectBridge({
      onToolCall: vi.fn(),
      onEvent,
    });
    disconnectWithTools([
      { id: "call-1", name: "lookup", args: {} },
      { id: "call-2", name: "lookup", args: {} },
    ]);
    await vi.advanceTimersByTimeAsync(250);

    const resumedSession = lastConnectParams().callbacks;
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
    const onClose = vi.fn();
    const onTranscript = vi.fn();
    await connectBridge({
      providerConfig: { model: LEGACY },
      onClose,
      onTranscript,
    });
    const firstSession = lastConnectParams().callbacks;
    firstSession.onmessage({
      setupComplete: {},
      sessionResumptionUpdate: { resumable: true, newHandle: "resume-1" },
      serverContent: { inputTranscription: { text: "Last words" } },
    });
    connectMock
      .mockRejectedValueOnce(new Error("connect failed 1"))
      .mockRejectedValueOnce(new Error("connect failed 2"))
      .mockRejectedValueOnce(new Error("connect failed 3"));
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
    const freshSession = createMockGoogleLiveSession();
    connectMock
      .mockReturnValueOnce(Promise.resolve(session))
      .mockReturnValueOnce(pendingSession.promise);
    const onEvent = vi.fn();
    const onReady = vi.fn();
    const onTranscript = vi.fn();
    const bridge = await connectBridge({
      providerConfig: { model: LEGACY, sessionResumption: false },
      onEvent,
      onReady,
      onTranscript,
    });
    const firstCallbacks = lastConnectParams().callbacks;
    firstCallbacks.onopen();
    firstCallbacks.onmessage({ setupComplete: {} });
    firstCallbacks.onclose({ code: 1011, reason: "temporary" });
    const queuedAudio = Buffer.from([0x7f]);
    bridge.sendAudio(queuedAudio);
    await vi.advanceTimersByTimeAsync(250);

    const joiningConnect = bridge.connect();
    const secondJoiningConnect = bridge.connect();
    expect(connectMock).toHaveBeenCalledTimes(2);
    const freshCallbacks = lastConnectParams().callbacks;
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
    expect(onTranscript.mock.calls.filter((call) => call[2] === true)).toEqual([
      ["user", "Next", true],
    ]);
  });

  it("copies and bounds pending audio by aggregate bytes before activation", async () => {
    const bridge = createGoogleLiveBridge({ audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ });
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
    const bridge = createGoogleLiveBridge({ audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ });

    for (let index = 0; index < 321; index += 1) {
      bridge.sendAudio(Buffer.alloc(2, index & 0xff));
    }

    await bridge.connect();
    activate();

    expect(session.sendRealtimeInput).toHaveBeenCalledTimes(320);
  });

  it("drops reconnect audio on terminal exhaustion until an explicit reconnect owns admission", async () => {
    vi.useFakeTimers();
    const reconnectedSession = createMockGoogleLiveSession();
    const onClose = vi.fn();
    const onEvent = vi.fn();
    const bridge = await connectBridge({
      audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      onClose,
      onEvent,
    });
    const firstSession = lastConnectParams().callbacks;
    firstSession.onopen();
    firstSession.onmessage({ setupComplete: { sessionId: "session-1" } });
    connectMock
      .mockRejectedValueOnce(new Error("connect failed 1"))
      .mockRejectedValueOnce(new Error("connect failed 2"))
      .mockRejectedValueOnce(new Error("connect failed 3"))
      .mockResolvedValueOnce(reconnectedSession);
    firstSession.onclose({ code: 1011, reason: "temporary" });
    bridge.sendAudio(Buffer.from([0x01, 0x00]));

    await vi.advanceTimersByTimeAsync(1_750);
    bridge.sendAudio(Buffer.from([0x02, 0x00]));

    expect(onEvent.mock.calls).toEqual([
      [{ direction: "client", type: "session.continuity.reset" }],
    ]);
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith("error");

    await bridge.connect();
    const reconnected = lastConnectParams().callbacks;
    reconnected.onopen();
    reconnected.onmessage({ setupComplete: { sessionId: "session-2" } });
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
    const connectedSession = createMockGoogleLiveSession();
    connectMock.mockReturnValueOnce(pendingSession.promise);
    const bridge = createGoogleLiveBridge({
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

  it("marks the Google audio stream complete after sustained telephony silence", async () => {
    const bridge = await openConfiguredBridge({ providerConfig: { silenceDurationMs: 60 } });

    const silence20ms = Buffer.alloc(160, 0xff);
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
    const bridge = await openConfiguredBridge({ providerConfig: { model } });
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
    const onAudio = vi.fn();
    const onError = vi.fn();
    const onClose = vi.fn();
    const onTranscript = vi.fn();
    const bridge = await connectBridge({
      audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
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
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Google Live stream returned malformed base64 audio data",
      }),
    );
    expect(onClose).toHaveBeenCalledWith("error");
    expect(session.close).toHaveBeenCalledTimes(1);
    await expect(bridge.connect()).rejects.toThrow(
      "Google Live stream returned malformed base64 audio data",
    );
  });

  it("terminates and clears a runaway transcript stream at the UTF-8 byte limit", async () => {
    const onError = vi.fn();
    const onClose = vi.fn();
    const onTranscript = vi.fn();
    const bridge = await connectBridge({
      providerConfig: { model: LEGACY },
      onError,
      onClose,
      onTranscript,
    });
    const callbacks = lastConnectParams().callbacks;
    const transcriptChunk = "€".repeat(Math.floor((256 * 1024) / 3));
    callbacks.onmessage({ serverContent: { inputTranscription: { text: transcriptChunk } } });
    callbacks.onmessage({ serverContent: { inputTranscription: { text: "€" } } });
    callbacks.onmessage({ serverContent: { inputTranscription: { text: "late fragment" } } });
    callbacks.onclose({ code: 1000, reason: "late clean close", wasClean: true });

    expect(onTranscript).toHaveBeenCalledOnce();
    expect(onTranscript.mock.calls.at(-1)).toEqual(["user", transcriptChunk, false]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Google Live transcript exceeded the 256 KiB UTF-8 pending buffer limit",
      }),
    );
    expect(onTranscript.mock.calls.filter((call) => call[2] === true)).toEqual([]);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith("error");
    expect(session.close).toHaveBeenCalledTimes(1);
    await expect(bridge.connect()).rejects.toThrow(
      "Google Live transcript exceeded the 256 KiB UTF-8 pending buffer limit",
    );
  });

  it("finalizes assistant turns without finalizing independently ordered 2.5 input", async () => {
    const onTranscript = vi.fn();
    const bridge = await connectBridge({
      providerConfig: { model: LEGACY },
      onTranscript,
    });
    const onmessage = lastConnectParams().callbacks.onmessage;
    onmessage({ serverContent: { inputTranscription: { text: "Earlier question. " } } });
    onmessage({ serverContent: { outputTranscription: { text: "Interrupted response " } } });
    onmessage({ serverContent: { interrupted: true } });
    onmessage({ serverContent: { turnComplete: true } });
    onmessage({
      serverContent: {
        inputTranscription: { text: "New question" },
        outputTranscription: { text: "ending" },
        turnComplete: true,
      },
    });

    expect(onTranscript.mock.calls.filter((call) => call[2] === true)).toEqual([
      ["assistant", "Interrupted response", true],
      ["assistant", "ending", true],
    ]);

    void bridge.close();
    expect(onTranscript.mock.calls.filter((call) => call[2] === true)).toEqual([
      ["assistant", "Interrupted response", true],
      ["assistant", "ending", true],
      ["user", "Earlier question. New question", true],
    ]);
  });

  it("closes the Live session when the final transcript callback throws", async () => {
    const callbackError = new Error("transcript persistence failed");
    const onError = vi.fn();
    const bridge = createGoogleLiveBridge({
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
    const onToolCall = vi.fn();
    const onError = vi.fn();
    const onClose = vi.fn();
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
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Google Live tool-call session limit exceeded" }),
    );
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
      const onError = vi.fn();
      const bridge = createGoogleLiveBridge({
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
    const bridge = createGoogleLiveBridge({
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
    const onError = vi.fn();
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
