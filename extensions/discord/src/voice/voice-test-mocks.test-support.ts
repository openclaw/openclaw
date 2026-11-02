import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import type {
  controlRealtimeVoiceAgentRun,
  registerRealtimeVoiceSelection,
  RealtimeVoiceBridgeSession,
} from "openclaw/plugin-sdk/realtime-voice";
import { vi, type Mock } from "vitest";
import type { VoiceRealtimeSpeakerContext, VoiceSessionEntry } from "./session.js";
const mocks = await vi.hoisted(async () => {
  const { Readable } = await import("node:stream");
  type EventHandler = (...args: unknown[]) => unknown;
  type DaveState = {
    lastTransitionId?: number;
    reinitializing?: boolean;
    recoverFromInvalidTransition?: Mock;
    session: { setPassthroughMode: Mock };
  };
  const createConnectionMockLocal = () => {
    const handlers = new Map<string, EventHandler>();
    const daveSetPassthroughMode = vi.fn() as Mock;
    const dave: DaveState = { session: { setPassthroughMode: daveSetPassthroughMode } };
    const state = { status: "ready", networking: { state: { code: "networking-ready", dave } } };
    const subscribe: Mock = vi.fn(() => Readable.from([]));
    const speakingHandlers = new Map<string, EventHandler>();
    const users = new Map<string, number>();
    const speaking: {
      users: Map<string, number>;
      emit: (event: string, userId: string) => void;
      on: Mock;
      off: Mock;
    } = {
      users,
      on: vi.fn((event: string, handler: EventHandler) => {
        speakingHandlers.set(event, handler);
      }),
      off: vi.fn((event: string) => {
        speakingHandlers.delete(event);
      }),
      emit: (event, userId) => {
        if (event === "start") {
          connection.receiver.speaking.users.set(userId, Date.now());
        } else {
          connection.receiver.speaking.users.delete(userId);
        }
        speakingHandlers.get(event)?.(userId);
      },
    };
    const connection = {
      destroy: vi.fn((): void => {
        connection.state.status = "destroyed";
      }) as Mock,
      subscribe: vi.fn() as Mock,
      on: vi.fn((event: string, handler: EventHandler) => {
        handlers.set(event, handler);
      }),
      off: vi.fn() as Mock,
      receiver: {
        speaking,
        subscribe,
      },
      state,
      daveSetPassthroughMode,
      handlers,
    };
    return connection;
  };

  const createRealtimeSessionMockLocal = (
    outputAudioMode: "response" | "continuous" = "response",
  ) => ({
    bridge: {
      outputAudioMode,
      pacesInputAudio: false,
      supportsToolResultContinuation: true,
      supportsToolResultSuppression: true as boolean | undefined,
      handleBargeIn: vi.fn() as Mock | undefined,
    },
    acknowledgeMark: vi.fn() as Mock,
    close: vi.fn() as Mock,
    connect: vi.fn<RealtimeVoiceBridgeSession["connect"]>(async () => undefined),
    sendAudio: vi.fn() as Mock,
    sendUserMessage: vi.fn() as Mock,
    handleBargeIn: vi.fn() as Mock,
    setMediaTimestamp: vi.fn() as Mock,
    submitToolResult: vi.fn() as Mock,
    triggerGreeting: vi.fn() as Mock,
  });
  const realtimeSessionMockLocal = createRealtimeSessionMockLocal();

  return {
    syntheticVoiceAdmissions: new WeakMap<
      VoiceSessionEntry,
      Map<string, VoiceRealtimeSpeakerContext>
    >(),
    createConnectionMock: createConnectionMockLocal,
    getVoiceConnectionMock: vi.fn<() => ReturnType<typeof createConnectionMockLocal> | undefined>(),
    joinVoiceChannelMock: vi.fn(() => createConnectionMockLocal()),
    entersStateMock: vi.fn(
      async (_target?: unknown, _state?: string, _timeoutOrSignal?: number | AbortSignal) =>
        undefined,
    ),
    createAudioResourceMock: vi.fn(() => ({
      playbackDuration: 0,
      read: vi.fn(() => null),
    })) as Mock,
    createAudioPlayerMock: vi.fn(() => {
      const listeners = new Map<string, EventHandler[]>();
      let status = "idle";
      const state = {
        get status() {
          return status;
        },
        set status(value: string) {
          const old = { status };
          status = value;
          for (const listener of listeners.get("stateChange") ?? []) {
            listener(old, state);
          }
        },
      };
      return {
        emit(event: string, ...args: unknown[]) {
          for (const listener of listeners.get(event) ?? []) {
            listener(...args);
          }
        },
        on: vi.fn((event: string, listener: EventHandler) => {
          listeners.set(event, [...(listeners.get(event) ?? []), listener]);
        }),
        off: vi.fn((event: string, listener: EventHandler) => {
          listeners.set(
            event,
            (listeners.get(event) ?? []).filter((current) => current !== listener),
          );
        }),
        stop: vi.fn() as Mock,
        play: vi.fn() as Mock,
        state,
      };
    }),
    resolveAgentRouteMock: vi.fn(() => ({ agentId: "agent-1", sessionKey: "discord:g1:c1" })),
    agentCommandMock: vi.fn(
      async (
        _opts?: unknown,
        _runtime?: unknown,
      ): Promise<{ payloads?: Array<{ text?: string }> }> => ({ payloads: [] }),
    ),
    resolveRealtimeVoiceAgentContextInstructionsMock:
      vi.fn<(...args: unknown[]) => Promise<string>>(),
    resolveVoiceIngressWithParticipantsMock: vi.fn() as Mock,
    transcribeAudioFileMock: vi.fn<PluginRuntime["mediaUnderstanding"]["transcribeAudioFile"]>(),
    prepareTtsRequestMock: vi.fn(async ({ cfg, text }: { cfg: unknown; text: string }) => ({
      cfg,
      directives: { cleanedText: text, hasDirective: false, overrides: {}, warnings: [] },
    })),
    textToSpeechStreamMock: vi.fn(async (): Promise<unknown> => ({
      success: false,
      error: "stream unavailable",
    })),
    textToSpeechMock: vi.fn(async () => ({ success: true, audioPath: "/tmp/voice.mp3" })),
    logVerboseMock: vi.fn() as Mock,
    loggerInfoMock: vi.fn() as Mock,
    loggerWarnMock: vi.fn() as Mock,
    loggerErrorMock: vi.fn() as Mock,
    resolveConfiguredRealtimeVoiceProviderMock: vi.fn<
      (params?: {
        configuredProviderId?: string;
        providerConfigOverrides?: Record<string, unknown>;
        isProviderAvailable?: (provider: { id: string }) => boolean;
        assertProviderAvailable?: (provider: { id: string }) => void;
      }) => {
        provider: { id: string };
        capabilities?: {
          supportsActivationNameGating?: boolean;
          handlesAgentConsult?: boolean;
          voices?: string[];
        };
        providerConfig: Record<string, unknown>;
      }
    >(() => ({
      provider: { id: "openai" },
      capabilities: { supportsActivationNameGating: true },
      providerConfig: { model: "gpt-realtime-2", voice: "cedar" },
    })),
    registerRealtimeVoiceSelectionMock: vi.fn<typeof registerRealtimeVoiceSelection>(),
    createRealtimeVoiceBridgeSessionMock: vi.fn((_params?: unknown) => realtimeSessionMockLocal),
    controlRealtimeVoiceAgentRunMock: vi.fn<typeof controlRealtimeVoiceAgentRun>(),
    createRealtimeSessionMock: createRealtimeSessionMockLocal,
    realtimeSessionMock: realtimeSessionMockLocal,
    resolveAudioInputBudgetMock:
      vi.fn<PluginRuntime["mediaUnderstanding"]["resolveAudioInputBudget"]>(),
    decodeOpusStreamChunksMock: vi.fn<(typeof import("./audio.js"))["decodeOpusStreamChunks"]>(),
    updateVoiceStateMock: vi.fn() as Mock,
    enqueueSystemEventMock: vi.fn() as Mock,
    assertSecretOwnerAvailableMock: vi.fn() as Mock,
    isSecretOwnerAvailableMock: vi.fn((_ownerKind: string, _ownerId: string) => true),
    canonicalizeRealtimeVoiceProviderIdMock: vi.fn((providerId: string | undefined) =>
      providerId?.trim().toLowerCase(),
    ),
  };
});

export const voiceTestMocks = mocks;

vi.mock("openclaw/plugin-sdk/channel-secret-owner-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/channel-secret-owner-runtime")>();
  return {
    ...actual,
    assertSecretOwnerAvailable: mocks.assertSecretOwnerAvailableMock,
    isSecretOwnerAvailable: mocks.isSecretOwnerAvailableMock,
  };
});

vi.mock("./audio-worker-thread.js", async () => {
  const { InProcessDiscordAudioWorker } = await import("./audio-worker.test-support.js");
  return {
    createDiscordAudioWorkerThread: (
      options: import("./audio-worker-protocol.js").DiscordAudioWorkerOptions,
    ) => {
      const worker = new InProcessDiscordAudioWorker(undefined, { workerData: options });
      vi.spyOn(worker.media["player"], "stop");
      return worker;
    },
  };
});

// mock-isolation: voice lifecycle tests own synthetic Discord transports, not live clients.
vi.mock("./sdk-runtime.js", () => ({
  loadDiscordVoiceSdk: () => ({
    AudioPlayerStatus: { Playing: "playing", Idle: "idle" },
    EndBehaviorType: { AfterSilence: "AfterSilence", Manual: "Manual" },
    NetworkingStatusCode: { Ready: "networking-ready", Resuming: "networking-resuming" },
    StreamType: { Opus: "opus", Raw: "raw" },
    VoiceConnectionStatus: {
      Ready: "ready",
      Disconnected: "disconnected",
      Destroyed: "destroyed",
      Signalling: "signalling",
      Connecting: "connecting",
    },
    createAudioPlayer: mocks.createAudioPlayerMock,
    createAudioResource: mocks.createAudioResourceMock,
    entersState: mocks.entersStateMock,
    getVoiceConnection: mocks.getVoiceConnectionMock,
    joinVoiceChannel: mocks.joinVoiceChannelMock,
  }),
}));

vi.mock("openclaw/plugin-sdk/routing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/routing")>();
  return { ...actual, resolveAgentRoute: mocks.resolveAgentRouteMock };
});

vi.mock("openclaw/plugin-sdk/agent-scope-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-scope-runtime")>();
  return { ...actual, resolveAgentDir: vi.fn(() => "/tmp/openclaw-agent") };
});

vi.mock("openclaw/plugin-sdk/realtime-bootstrap-context", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/realtime-bootstrap-context")>();
  return {
    ...actual,
    resolveRealtimeVoiceAgentContextInstructions:
      mocks.resolveRealtimeVoiceAgentContextInstructionsMock,
  };
});

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => ({
      ...actual.createSubsystemLogger(subsystem),
      info: mocks.loggerInfoMock,
      warn: mocks.loggerWarnMock,
      error: mocks.loggerErrorMock,
    }),
    logVerbose: mocks.logVerboseMock,
  };
});

// mock-isolation: capture emitted events without writing to the process event queue.
vi.mock("openclaw/plugin-sdk/system-event-runtime", () => ({
  enqueueRoutedSystemEvent: (
    text: unknown,
    route: { sessionKey: unknown },
    options: Record<string, unknown>,
  ) => mocks.enqueueSystemEventMock(text, { ...options, sessionKey: route.sessionKey }),
}));

vi.mock("openclaw/plugin-sdk/realtime-voice", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/realtime-voice")>();
  return {
    ...actual,
    registerRealtimeVoiceSelection: mocks.registerRealtimeVoiceSelectionMock.mockImplementation(
      actual.registerRealtimeVoiceSelection,
    ),
    canonicalizeRealtimeVoiceProviderId: mocks.canonicalizeRealtimeVoiceProviderIdMock,
    createRealtimeVoiceBridgeSession: mocks.createRealtimeVoiceBridgeSessionMock,
    createRealtimeVoiceSessionHarness: (
      params: Parameters<typeof actual.createRealtimeVoiceSessionHarness>[0],
    ) => {
      const harness = actual.createRealtimeVoiceSessionHarness(params);
      let providerSession: typeof mocks.realtimeSessionMock | undefined;
      return {
        ...harness,
        createBridge: (bridgeParams: Parameters<typeof harness.createBridge>[0]) =>
          harness.createBridge({
            ...bridgeParams,
            provider: {
              ...bridgeParams.provider,
              label: bridgeParams.provider.label ?? "Test realtime provider",
              isConfigured: bridgeParams.provider.isConfigured ?? (() => true),
              createBridge: (request) => {
                const session = mocks.createRealtimeVoiceBridgeSessionMock({
                  ...bridgeParams,
                  audioSink: {
                    ...bridgeParams.audioSink,
                    sendAudio: request.onAudio,
                    clearAudio: request.onClearAudio,
                  },
                  onEvent: request.onEvent,
                  onClose: request.onClose,
                  onReady: request.onReady,
                  onResponseDone: request.onResponseDone,
                  onToolCall: bridgeParams.onToolCall,
                  onTranscript: request.onTranscript,
                  runAgentConsult: request.runAgentConsult,
                });
                providerSession = session;
                const { bridge, handleBargeIn, submitToolResult, ...methods } = session;
                return {
                  ...methods,
                  outputAudioMode: bridge.outputAudioMode,
                  pacesInputAudio: bridge.pacesInputAudio,
                  supportsToolResultContinuation: bridge.supportsToolResultContinuation,
                  supportsToolResultSuppression: bridge.supportsToolResultSuppression,
                  ...(bridge.handleBargeIn ? { handleBargeIn } : {}),
                  isConnected: () => true,
                  submitToolResult: (callId, result, options) =>
                    options === undefined
                      ? submitToolResult.call(session, callId, result)
                      : submitToolResult.call(session, callId, result, options),
                };
              },
            },
          }),
        flushOutput: (flush: () => void) => flush(),
        handleBargeIn: (
          options: Parameters<typeof harness.handleBargeIn>[0],
          fallbackFlush: () => void,
        ) => {
          providerSession?.handleBargeIn(options);
          // The mock provider never clears audio, so exercise the harness fallback directly.
          // Discord passes a no-op for normal truncation and a real clear for forced paths.
          fallbackFlush();
        },
      };
    },
    controlRealtimeVoiceAgentRun: mocks.controlRealtimeVoiceAgentRunMock,
    resolveConfiguredRealtimeVoiceProviderAsync: mocks.resolveConfiguredRealtimeVoiceProviderMock,
  };
});

vi.mock("./audio.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./audio.js")>();
  const { PassThrough } = await import("node:stream");
  return {
    ...actual,
    DiscordOpusEncodeStream: vi.fn(function () {
      return Object.assign(new PassThrough(), {
        flushPartialFrame: () => false,
        flushPartialFrameWhenReady: () => {},
        takePcmBytes: (packet: Buffer) => packet.length,
      });
    }),
    createDiscordOpusPlaybackStream: vi.fn(() => new PassThrough()),
    decodeOpusStreamChunks: mocks.decodeOpusStreamChunksMock,
  };
});

vi.mock("./participant-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./participant-context.js")>();
  return {
    ...actual,
    resolveDiscordVoiceIngressContextWithParticipants: (
      ...args: Parameters<typeof actual.resolveDiscordVoiceIngressContextWithParticipants>
    ) => {
      if (mocks.resolveVoiceIngressWithParticipantsMock.getMockImplementation()) {
        return mocks.resolveVoiceIngressWithParticipantsMock(...args);
      }
      const context = mocks.syntheticVoiceAdmissions.get(args[0].entry)?.get(args[0].userId);
      return context
        ? Promise.resolve(context)
        : actual.resolveDiscordVoiceIngressContextWithParticipants(...args);
    },
  };
});

// mock-isolation: the voice harness supplies its own plugin runtime and credentials.
vi.mock("../runtime.js", () => ({
  getDiscordRuntime: () => ({
    agent: {
      runCommandFromIngress: mocks.agentCommandMock,
      session: { getSessionEntry: () => undefined },
    },
    mediaUnderstanding: {
      resolveAudioInputBudget: mocks.resolveAudioInputBudgetMock,
      transcribeAudioFile: mocks.transcribeAudioFileMock,
    },
    tts: {
      prepareTtsRequest: mocks.prepareTtsRequestMock,
      textToSpeechStream: mocks.textToSpeechStreamMock,
      textToSpeech: mocks.textToSpeechMock,
    },
  }),
}));
