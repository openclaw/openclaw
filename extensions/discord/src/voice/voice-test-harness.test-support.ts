import { PassThrough } from "node:stream";
import { VoiceOpcodes } from "discord-api-types/voice/v8";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelType } from "../internal/discord.js";
import {
  createDefaultVoiceStates,
  createDiscordVoiceTestHelpers,
  createRealtimeBridgeTestHelpers,
  createVoiceTestRuntime,
  lastMockCall,
  mockCall,
  type MockCallSource,
  type TestRealtimeBridgeParams,
  requireRecord,
} from "./manager.e2e.test-support.js";
import { DECRYPT_FAILURE_WINDOW_MS } from "./receive-recovery.js";
import type { VoiceRealtimeSpeakerContext, VoiceSessionEntry } from "./session.js";
import { createDiscordVoiceTranscriptFixture } from "./transcripts.test-support.js";
import {
  installFailingDaveSession,
  makePoisonedDaveConnections,
} from "./voice-dave.test-support.js";
import { voiceTestMocks as mocks } from "./voice-test-mocks.test-support.js";

// Load the in-process media owner only after voice-test-mocks has registered
// SDK/audio mocks. An eager helper import permanently captures the real network SDK.
const { getDiscordAudioTestWorker } = await import("./audio-worker.test-support.js");
// Parallel entry points can race Vitest's async audio mock and capture different exports.
const managerModule = await import("./voice-runtime.js");
const realtimeModule = await import("./realtime-session.runtime.js");
type Manager = InstanceType<typeof managerModule.DiscordVoiceManager>;
type ManagerParams = ConstructorParameters<typeof managerModule.DiscordVoiceManager>[0];
type DiscordConfig = ManagerParams["discordConfig"];
type VoiceConfig = NonNullable<DiscordConfig["voice"]>;
type AgentProxyConfigOverrides = Omit<Partial<DiscordConfig>, "voice"> & {
  voice?: Partial<VoiceConfig>;
};

const { configureVoiceStateGateway, createClient, createClientWithMember } =
  createDiscordVoiceTestHelpers(mocks.updateVoiceStateMock);
const createRuntime = createVoiceTestRuntime;
const decryptError = () =>
  new Error("Failed to decrypt: DecryptionFailed(UnencryptedWhenPassthroughDisabled)");

function buildVoiceTestHarness() {
  const { startTranscripts, stopTranscripts } = createDiscordVoiceTranscriptFixture();
  const managers = new Set<Manager>();
  afterEach(async () => {
    await Promise.all([...managers].map((manager) => manager.destroy()));
    managers.clear();
  });
  beforeEach(() => {
    mocks.getVoiceConnectionMock.mockReset().mockReturnValue(undefined);
    mocks.joinVoiceChannelMock.mockReset().mockImplementation(() => mocks.createConnectionMock());
    mocks.entersStateMock.mockReset().mockResolvedValue(undefined);
    mocks.createAudioPlayerMock.mockClear();
    mocks.resolveAgentRouteMock
      .mockReset()
      .mockReturnValue({ agentId: "agent-1", sessionKey: "discord:g1:c1" });
    mocks.agentCommandMock.mockReset().mockResolvedValue({ payloads: [] });
    mocks.resolveRealtimeVoiceAgentContextInstructionsMock
      .mockReset()
      .mockResolvedValue("Agent context: shared voice agent context.");
    mocks.resolveVoiceIngressWithParticipantsMock.mockReset();
    mocks.transcribeAudioFileMock.mockReset().mockResolvedValue({ text: "hello from voice" });
    mocks.prepareTtsRequestMock
      .mockReset()
      .mockImplementation(async ({ cfg, text }: { cfg: unknown; text: string }) => ({
        cfg,
        directives: {
          cleanedText: text,
          hasDirective: false,
          overrides: {},
          warnings: [],
        },
      }));
    mocks.textToSpeechStreamMock.mockReset().mockResolvedValue({
      success: false,
      error: "TTS conversion failed: elevenlabs: upstream unavailable",
      attemptedProviders: ["elevenlabs"],
      attempts: [
        {
          provider: "elevenlabs",
          outcome: "failed",
          reasonCode: "provider_error",
          latencyMs: 12,
          error: "elevenlabs: upstream unavailable",
        },
      ],
    });
    mocks.textToSpeechMock
      .mockReset()
      .mockResolvedValue({ success: true, audioPath: "/tmp/voice.mp3" });
    mocks.logVerboseMock.mockClear();
    mocks.loggerWarnMock.mockClear();
    mocks.loggerErrorMock.mockClear();
    mocks.updateVoiceStateMock.mockClear();
    mocks.enqueueSystemEventMock.mockClear().mockReturnValue(true);
    mocks.assertSecretOwnerAvailableMock.mockReset();
    mocks.isSecretOwnerAvailableMock.mockReset().mockReturnValue(true);
    mocks.canonicalizeRealtimeVoiceProviderIdMock
      .mockReset()
      .mockImplementation((providerId: string | undefined) => providerId?.trim().toLowerCase());
    mocks.createAudioResourceMock.mockClear();
    mocks.realtimeSessionMock.close.mockClear();
    mocks.realtimeSessionMock.connect.mockReset().mockResolvedValue(undefined);
    mocks.realtimeSessionMock.sendAudio.mockClear();
    mocks.realtimeSessionMock.sendUserMessage.mockClear();
    mocks.realtimeSessionMock.handleBargeIn.mockClear();
    mocks.realtimeSessionMock.setMediaTimestamp.mockClear();
    mocks.realtimeSessionMock.submitToolResult.mockClear();
    mocks.realtimeSessionMock.bridge.supportsToolResultSuppression = true;
    mocks.realtimeSessionMock.bridge.pacesInputAudio = false;
    mocks.realtimeSessionMock.bridge.outputAudioMode = "response";
    mocks.createRealtimeVoiceBridgeSessionMock
      .mockReset()
      .mockImplementation(() =>
        mocks.createRealtimeVoiceBridgeSessionMock.mock.calls.length === 1
          ? mocks.realtimeSessionMock
          : mocks.createRealtimeSessionMock(),
      );
    mocks.controlRealtimeVoiceAgentRunMock.mockReset().mockResolvedValue({
      ok: false,
      mode: "steer",
      sessionKey: "discord:g1:c1",
      active: false,
      queued: false,
      reason: "no_active_run",
      message: "There is no active OpenClaw run to steer.",
      speak: true,
      show: true,
      suppress: false,
    });
    mocks.resolveConfiguredRealtimeVoiceProviderMock.mockClear();
    mocks.registerRealtimeVoiceSelectionMock.mockClear();
    mocks.resolveConfiguredRealtimeVoiceProviderMock.mockReturnValue({
      provider: { id: "openai" },
      capabilities: { supportsActivationNameGating: true },
      providerConfig: { model: "gpt-realtime-2", voice: "cedar" },
    });
    mocks.decodeOpusStreamChunksMock.mockReset().mockResolvedValue(undefined);
    mocks.resolveAudioInputBudgetMock
      .mockReset()
      .mockImplementation(async ({ cfg }) =>
        cfg.tools?.media?.audio?.enabled === false
          ? { enabled: false }
          : { enabled: true, maxBytes: cfg.tools?.media?.audio?.maxBytes ?? 20 * 1024 * 1024 },
      );
  });

  const createManager = (
    discordConfig: DiscordConfig = { voice: { enabled: true, mode: "stt-tts" } },
    clientOverride?: ReturnType<typeof createClient>,
    cfgOverride: ManagerParams["cfg"] = {},
    accountId = "default",
    botUserId?: string,
  ) => {
    const manager = new managerModule.DiscordVoiceManager({
      scheduler: createTestPluginServiceScheduler(),
      client: (clientOverride ?? createClient()) as never,
      cfg: cfgOverride,
      discordConfig,
      accountId,
      runtime: createRuntime(),
      botUserId,
    });
    managers.add(manager);
    return manager;
  };

  const makeVoiceConfig = (
    voice: Partial<VoiceConfig> = {},
    overrides: Omit<Partial<DiscordConfig>, "voice"> = {},
  ): DiscordConfig => ({
    ...overrides,
    voice: { enabled: true, mode: "stt-tts", ...voice },
  });

  const makeAgentProxyConfig = (overrides: AgentProxyConfigOverrides = {}): DiscordConfig => {
    const { voice, ...discord } = overrides;
    return makeVoiceConfig(
      {
        mode: "agent-proxy",
        ...voice,
        realtime: { provider: "openai", ...voice?.realtime },
      },
      { groupPolicy: "open", ...discord },
    );
  };

  const makeBidiConfig = ({ voice, ...discord }: AgentProxyConfigOverrides = {}) =>
    makeAgentProxyConfig({ ...discord, voice: { mode: "bidi", ...voice } });

  const createAgentProxyManager = (
    client?: ReturnType<typeof createClient>,
    overrides?: AgentProxyConfigOverrides,
    cfg?: ManagerParams["cfg"],
    botUserId?: string,
  ) => createManager(makeAgentProxyConfig(overrides), client, cfg, "default", botUserId);

  const getSessionEntry = (manager: Manager, guildId = "g1"): VoiceSessionEntry => {
    const entry = manager["sessions"].get(guildId);
    if (!entry) {
      throw new Error(`expected Discord voice session for guild ${guildId}`);
    }
    return entry;
  };

  const getVoiceReceive = (manager: Manager) => manager["receive"];

  const beginSpeakerTurn = (
    entry: VoiceSessionEntry,
    params: Partial<VoiceRealtimeSpeakerContext> & {
      userId?: string;
      initialAudio?: Buffer | null;
      realAdmission?: boolean;
    } = {},
  ) => {
    const lifecycle = entry.realtimeLifecycle;
    if (lifecycle.status !== "active") {
      throw new Error(`expected active Discord realtime session, got ${lifecycle.status}`);
    }
    const senderIsOwner = params.senderIsOwner ?? true;
    const userId = params.userId ?? (senderIsOwner ? "u-owner" : "u-guest");
    const context = {
      extraSystemPrompt: params.extraSystemPrompt,
      senderIsOwner,
      speakerLabel: params.speakerLabel ?? (senderIsOwner ? "Owner" : "Guest"),
    };
    // Manual turns bypass ingress; retain only their explicit synthetic admission for rechecks.
    if (params.realAdmission) {
      mocks.syntheticVoiceAdmissions.get(entry)?.delete(userId);
    } else {
      let speakers = mocks.syntheticVoiceAdmissions.get(entry);
      if (!speakers) {
        speakers = new Map();
        mocks.syntheticVoiceAdmissions.set(entry, speakers);
      }
      speakers.set(userId, context);
    }
    const turn = lifecycle.instance.beginSpeakerTurn(context, userId);
    // Null preserves cases that start provider output before sending the first speaker audio.
    if (params.initialAudio !== null) {
      turn.sendInputAudio(params.initialAudio ?? Buffer.alloc(3840));
    }
    return turn;
  };

  const createWakeNameFixture = async (agentName = "Molty") =>
    joinManagerFixture(
      createAgentProxyManager(
        undefined,
        { voice: { realtime: { consultPolicy: "auto", requireWakeName: true } } },
        {
          agents: { entries: { "agent-1": { identity: { name: agentName } } } },
          commands: { ownerAllowFrom: ["user:u-owner"] },
        },
      ),
    );

  const getLastAudioPlayer = (): ReturnType<typeof mocks.createAudioPlayerMock> =>
    expectDefined(mocks.createAudioPlayerMock.mock.results.at(-1)?.value, "voice audio player");

  const callArgs = (source: MockCallSource, label: string, index?: number) =>
    requireRecord(
      (index === undefined ? lastMockCall(source, label) : mockCall(source, index, label))[0],
      `${label} args`,
    );

  const { realtimeBridgeAt, lastRealtimeBridge, lastRealtimeBridgeParams, sentUserMessages } =
    createRealtimeBridgeTestHelpers(mocks.createRealtimeVoiceBridgeSessionMock);

  const joinManagerFixture = async (manager: Manager) => {
    await manager.join({ guildId: "g1", channelId: "1001" });
    return {
      bridgeParams: lastRealtimeBridgeParams(),
      entry: getSessionEntry(manager),
      manager,
      player: getLastAudioPlayer(),
    };
  };

  const flushRealtimeForcedConsultTimers = async (emitTranscripts: () => void | Promise<void>) => {
    vi.useFakeTimers();
    try {
      await emitTranscripts();
      await vi.advanceTimersByTimeAsync(260);
    } finally {
      vi.useRealTimers();
    }
  };

  const handleSpeakingStart = async (manager: Manager, entry: VoiceSessionEntry, userId: string) =>
    await getVoiceReceive(manager).handleSpeakingStart(entry, userId);

  const getSessionConnection = (entry: VoiceSessionEntry) =>
    expectDefined(
      mocks.joinVoiceChannelMock.mock.results.find(({ value }) =>
        Object.is(value, getDiscordAudioTestWorker(entry.audio)["connection"]),
      )?.value,
      "voice session connection",
    );

  const openWorkerReceiveCapture = async (manager: Manager, guildId = "g1") => {
    const entry = getSessionEntry(manager, guildId);
    const connection = getSessionConnection(entry);
    const userId = "u-owner";
    const source = new PassThrough({ objectMode: true });
    const subscribed = createDeferred<void>();
    connection.receiver.subscribe.mockReturnValueOnce(source);
    // Retain the real worker receive owner. This codec stand-in merely waits
    // for the SDK source to end; injected decryption fails before codec work.
    mocks.decodeOpusStreamChunksMock.mockImplementationOnce(
      async (input: import("node:stream").Readable) => {
        subscribed.resolve();
        for await (const packet of input) {
          expect(packet).toHaveLength(0); // No valid audio precedes this fault.
        }
      },
    );
    const receiving = handleSpeakingStart(manager, entry, userId);
    await Promise.race([
      subscribed.promise,
      receiving.then(() => {
        throw new Error("Expected an admitted worker-owned receive subscription");
      }),
    ]);
    const captured = expectDefined(entry.capture.get(userId)?.stream, "main capture projection");
    const errors: Error[] = [];
    const observeError = (error: Error) => {
      errors.push(error);
    };
    captured.on("error", observeError);
    const settled = receiving.finally(() => captured.off("error", observeError));
    return { entry, connection, source, receiving: settled, errors };
  };

  const receiveRecordedSpeech = async (
    manager: Manager,
    text?: string,
    entry = getSessionEntry(manager),
    userId = "u-owner",
  ) => {
    const conversations = vi.spyOn(entry.conversations, "enqueue");
    const stream = new PassThrough({ objectMode: true });
    getSessionConnection(entry).receiver.subscribe.mockReturnValueOnce(stream);
    // Mock the codec and provider response, retaining receive ownership and WAV/STT dispatch.
    mocks.decodeOpusStreamChunksMock.mockImplementation(async (input, callbacks) => {
      for await (const pcm of input) {
        await callbacks.onChunk(pcm, pcm);
      }
    });
    if (text !== undefined) {
      mocks.transcribeAudioFileMock.mockResolvedValue({ text });
    }
    try {
      const receiving = handleSpeakingStart(manager, entry, userId);
      stream.end(Buffer.alloc(96_000));
      await receiving;
      await entry.processingQueue;
      await Promise.all(conversations.mock.results.map((result) => result.value));
    } finally {
      stream.destroy();
      conversations.mockRestore();
    }
  };

  return {
    createRecordingFixture: async (config?: AgentProxyConfigOverrides) => {
      const manager = createAgentProxyManager(undefined, config);
      const onUtterance = vi.fn();
      expect(await startTranscripts(manager, onUtterance)).toMatchObject({ ok: true });
      return { manager, onUtterance, entry: getSessionEntry(manager) };
    },
    blockOperation: (mock: {
      mockImplementationOnce: (callback: () => Promise<undefined>) => unknown;
    }) => {
      const entered = createDeferred<void>();
      const ready = createDeferred<undefined>();
      mock.mockImplementationOnce(() => {
        entered.resolve();
        return ready.promise;
      });
      return { entered: entered.promise, release: () => ready.resolve(undefined) };
    },
    useConnection: () => {
      const connection = mocks.createConnectionMock();
      mocks.joinVoiceChannelMock.mockReturnValueOnce(connection);
      return connection;
    },
    startTranscripts,
    stopTranscripts,
    expectDefined,
    VoiceOpcodes,
    expect,
    it,
    vi,
    ChannelType,
    DECRYPT_FAILURE_WINDOW_MS,
    requireRecord,
    mockCall,
    lastMockCall,
    createDefaultVoiceStates,
    ...mocks,
    managerModule,
    realtimeModule,
    configureVoiceStateGateway,
    createClient,
    createClientWithMember,
    createRuntime,
    createManager,
    makeVoiceConfig,
    makeAgentProxyConfig,
    createAgentProxyManager,
    createFollowManager: (
      voice: Partial<VoiceConfig> = {},
      clientOverride?: ReturnType<typeof createClient>,
      overrides: Omit<Partial<DiscordConfig>, "voice"> = {},
      botUserId?: string,
    ) =>
      createManager(
        makeVoiceConfig({ followUsers: ["u-owner"], ...voice }, overrides),
        clientOverride,
        {},
        "default",
        botUserId,
      ),
    expectConnectedStatus: (manager: Manager, channelId: string) => {
      expect(manager.status()).toEqual([
        {
          ok: true,
          message: `connected: guild g1 channel ${channelId}`,
          guildId: "g1",
          channelId,
        },
      ]);
    },
    getSessionEntry,
    getSessionConnection,
    getVoiceReceive,
    getVoiceFollowing: (manager: Manager) => manager["following"],
    beginSpeakerTurn,
    createWakeNameFixture,
    getLastAudioPlayer,
    expectOffEventWithFunction: (source: MockCallSource, event: string) => {
      const call = Array.from(source.mock.calls).find((candidate) => candidate[0] === event);
      if (!call) {
        throw new Error(`Expected ${event} listener removal`);
      }
      expect(call[1], `${event} listener`).toBeTypeOf("function");
    },
    lastAgentCommandArgs: () => callArgs(mocks.agentCommandMock, "agent command"),
    agentCommandArgsAt: (index: number) =>
      callArgs(mocks.agentCommandMock, `agent command ${index}`, index),
    realtimeBridgeAt,
    lastRealtimeBridge,
    lastRealtimeBridgeParams,
    createJoinedAgentProxyFixture: async (
      overrides: {
        client?: ReturnType<typeof createClient>;
        config?: AgentProxyConfigOverrides;
        cfg?: ManagerParams["cfg"];
      } = {},
    ) =>
      joinManagerFixture(
        createAgentProxyManager(overrides.client, overrides.config, overrides.cfg),
      ),
    createJoinedBidiFixture: async (config: AgentProxyConfigOverrides = {}) =>
      joinManagerFixture(createManager(makeBidiConfig(config))),
    lastAudioResourceInput: () => lastMockCall(mocks.createAudioResourceMock, "audio resource")[0],
    lastTtsArgs: () => callArgs(mocks.textToSpeechMock, "tts"),
    lastTtsStreamArgs: () => callArgs(mocks.textToSpeechStreamMock, "tts stream"),
    sentUserMessages,
    emitFinalRealtimeUserTranscript: async (
      bridgeParams: Pick<TestRealtimeBridgeParams, "onTranscript"> | null | undefined,
      text: string,
    ) => {
      await flushRealtimeForcedConsultTimers(() => {
        bridgeParams?.onTranscript?.("user", text, true);
      });
    },
    flushRealtimeForcedConsultTimers,
    expectUserMessageIncludes: (text: string) =>
      expect(sentUserMessages(), text).toContainEqual(expect.stringContaining(text)),
    expectUserMessageNotIncludes: (text: string) =>
      expect(sentUserMessages(), text).not.toContainEqual(expect.stringContaining(text)),
    // Projection-only fault for main-owned rejoin policy; native DAVE uses emitWorkerReceiveFailure.
    emitDecryptFailure: (manager: Manager) => {
      const entry = getSessionEntry(manager);
      getVoiceReceive(manager).handleReceiveError(entry, decryptError());
    },
    emitWorkerReceiveFailure: async (
      manager: Manager,
      options: { guildId?: string; error?: Error } = {},
    ) => {
      const capture = await openWorkerReceiveCapture(manager, options.guildId);
      // Capture startup separately re-arms passthrough; measure only fault recovery.
      capture.connection.daveSetPassthroughMode.mockClear();
      capture.source.destroy(options.error ?? decryptError());
      await capture.receiving;
      return capture.errors;
    },
    openWorkerReceiveCapture,
    installFailingDaveSession,
    makePoisonedDaveConnections,
    receiveVoiceUtterance: async (manager: Manager, userId: string) => {
      expect(await manager.join({ guildId: "g1", channelId: "1001" })).toMatchObject({ ok: true });
      await receiveRecordedSpeech(manager, undefined, getSessionEntry(manager), userId);
    },
    updateVoiceState: async (
      manager: Manager,
      userId: string,
      channelId: string | null,
      member?: Record<string, unknown>,
    ) => {
      await manager.handleVoiceStateUpdate({
        guild_id: "g1",
        user_id: userId,
        channel_id: channelId,
        ...(member ? { member } : {}),
      } as never);
    },
    handleSpeakingStart,
    receiveRecordedSpeech,
  };
}

export type DiscordVoiceTestHarness = ReturnType<typeof buildVoiceTestHarness>;

export function defineDiscordVoiceTests(
  register: (harness: DiscordVoiceTestHarness) => void,
): void {
  describe("DiscordVoiceManager", () => register(buildVoiceTestHarness()));
}
