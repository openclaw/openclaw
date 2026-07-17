// Google Meet plugin module implements realtime behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import {
  getRealtimeTranscriptionProvider,
  listRealtimeTranscriptionProviders,
  type RealtimeTranscriptionProviderConfig,
  type RealtimeTranscriptionProviderPlugin,
  type RealtimeTranscriptionSession,
} from "openclaw/plugin-sdk/realtime-transcription";
import {
  createRealtimeVoiceAgentTalkbackQueue,
  createRealtimeVoiceBridgeSession,
  createRealtimeVoiceOutputActivityTracker,
  createTalkSessionController,
  extendRealtimeVoiceOutputEchoSuppression,
  getRealtimeVoiceBridgeEventHealth,
  getRealtimeVoiceTranscriptHealth,
  isLikelyRealtimeVoiceAssistantEchoTranscript,
  recordRealtimeVoiceBridgeEvent,
  recordTalkObservabilityEvent,
  recordRealtimeVoiceTranscript,
  resolveConfiguredRealtimeVoiceProvider,
  type RealtimeVoiceAgentTalkbackQueue,
  type RealtimeVoiceBridgeEventLogEntry,
  type RealtimeVoiceBridgeSession,
  type RealtimeVoiceOutputActivityTracker,
  type RealtimeVoiceProviderConfig,
  type RealtimeVoiceProviderPlugin,
  type RealtimeVoiceTranscriptEntry,
  type TalkEvent,
  type TalkEventInput,
  type TalkSessionController,
} from "openclaw/plugin-sdk/realtime-voice";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  consultOpenClawAgentForGoogleMeet,
  handleGoogleMeetRealtimeConsultToolCall,
  resolveGoogleMeetRealtimeTools,
} from "./agent-consult.js";
import type { GoogleMeetConfig } from "./config.js";
import {
  convertGoogleMeetBridgeAudioForStt,
  convertGoogleMeetTtsAudioForBridge,
  resolveGoogleMeetRealtimeAudioFormat,
} from "./realtime-audio-format.js";
import type { MeetRealtimeAudioTransport } from "./realtime-audio-transport.js";
import type { GoogleMeetChromeHealth } from "./transports/types.js";

export type MeetRealtimeAudioEngineHandle = {
  providerId: string;
  speak: (instructions?: string) => void;
  getHealth: () => GoogleMeetChromeHealth;
  stop: () => Promise<void>;
};

type ResolvedRealtimeProvider = {
  provider: RealtimeVoiceProviderPlugin;
  providerConfig: RealtimeVoiceProviderConfig;
};

type ResolvedRealtimeTranscriptionProvider = {
  provider: RealtimeTranscriptionProviderPlugin;
  providerConfig: RealtimeTranscriptionProviderConfig;
};

type GoogleMeetRealtimeTranscriptEntry = RealtimeVoiceTranscriptEntry;
const recordGoogleMeetRealtimeTranscript = recordRealtimeVoiceTranscript;

function getGoogleMeetRealtimeTranscriptHealth(
  transcript: GoogleMeetRealtimeTranscriptEntry[],
): Pick<GoogleMeetChromeHealth, keyof ReturnType<typeof getRealtimeVoiceTranscriptHealth>> {
  return getRealtimeVoiceTranscriptHealth(transcript);
}

type GoogleMeetRealtimeEventEntry = RealtimeVoiceBridgeEventLogEntry;

const GOOGLE_MEET_AGENT_TRANSCRIPT_DEBOUNCE_MS = 900;
// Playback duration plus a tail blocks live loopback; transcript lookback catches delayed echo.
const GOOGLE_MEET_OUTPUT_ECHO_SUPPRESSION_TAIL_MS = 3_000;
const GOOGLE_MEET_TRANSCRIPT_ECHO_LOOKBACK_MS = 45_000;

function recordGoogleMeetRealtimeEvent(
  events: GoogleMeetRealtimeEventEntry[],
  event: Parameters<typeof recordRealtimeVoiceBridgeEvent>[1],
): void {
  recordRealtimeVoiceBridgeEvent(events, event);
}

function getGoogleMeetRealtimeEventHealth(
  events: GoogleMeetRealtimeEventEntry[],
): Pick<GoogleMeetChromeHealth, keyof ReturnType<typeof getRealtimeVoiceBridgeEventHealth>> {
  return getRealtimeVoiceBridgeEventHealth(events);
}

function isGoogleMeetLikelyAssistantEchoTranscript(params: {
  transcript: GoogleMeetRealtimeTranscriptEntry[];
  text: string;
  nowMs?: number;
}): boolean {
  return isLikelyRealtimeVoiceAssistantEchoTranscript({
    ...params,
    lookbackMs: GOOGLE_MEET_TRANSCRIPT_ECHO_LOOKBACK_MS,
  });
}

function extendGoogleMeetOutputEchoSuppression(params: {
  audio: Buffer;
  audioFormat: GoogleMeetConfig["chrome"]["audioFormat"];
  nowMs: number;
  lastOutputPlayableUntilMs: number;
  suppressInputUntilMs: number;
}): { lastOutputPlayableUntilMs: number; suppressInputUntilMs: number; durationMs: number } {
  const bytesPerMs = params.audioFormat === "g711-ulaw-8khz" ? 8 : 48;
  return extendRealtimeVoiceOutputEchoSuppression({
    ...params,
    bytesPerMs,
    tailMs: GOOGLE_MEET_OUTPUT_ECHO_SUPPRESSION_TAIL_MS,
  });
}

function recordGoogleMeetOutputActivity(params: {
  tracker: RealtimeVoiceOutputActivityTracker;
  audio: Buffer;
  audioFormat: GoogleMeetConfig["chrome"]["audioFormat"];
  nowMs: number;
  lastOutputPlayableUntilMs: number;
  suppressInputUntilMs: number;
}): { lastOutputPlayableUntilMs: number; suppressInputUntilMs: number; durationMs: number } {
  const suppression = extendGoogleMeetOutputEchoSuppression(params);
  params.tracker.markPlaybackStarted();
  params.tracker.markAudio({
    audioMs: suppression.durationMs,
    sourceAudioBytes: params.audio.byteLength,
    sinkAudioBytes: params.audio.byteLength,
  });
  return suppression;
}

function resolveGoogleMeetRealtimeProvider(params: {
  config: GoogleMeetConfig;
  fullConfig: OpenClawConfig;
  providers?: RealtimeVoiceProviderPlugin[];
}): ResolvedRealtimeProvider {
  const providerId = params.config.realtime.voiceProvider ?? params.config.realtime.provider;
  return resolveConfiguredRealtimeVoiceProvider({
    configuredProviderId: providerId,
    providerConfigs: params.config.realtime.providers,
    cfg: params.fullConfig,
    providers: params.providers,
    defaultModel: params.config.realtime.model,
    noRegisteredProviderMessage: "No configured realtime voice provider registered",
  });
}

function resolveGoogleMeetRealtimeTranscriptionProvider(params: {
  config: GoogleMeetConfig;
  fullConfig: OpenClawConfig;
  providers?: RealtimeTranscriptionProviderPlugin[];
}): ResolvedRealtimeTranscriptionProvider {
  const providers = params.providers ?? listRealtimeTranscriptionProviders(params.fullConfig);
  if (providers.length === 0) {
    throw new Error("No configured realtime transcription provider registered");
  }
  const providerId =
    params.config.realtime.transcriptionProvider ?? params.config.realtime.provider;
  const configuredProvider = providerId
    ? (params.providers?.find(
        (entry) => entry.id === providerId || entry.aliases?.includes(providerId),
      ) ?? getRealtimeTranscriptionProvider(providerId, params.fullConfig))
    : undefined;
  const provider = configuredProvider ?? providers[0];
  if (!provider) {
    throw new Error("No configured realtime transcription provider registered");
  }
  const rawConfig = providerId
    ? (params.config.realtime.providers[providerId] ??
      params.config.realtime.providers[provider.id] ??
      {})
    : (params.config.realtime.providers[provider.id] ?? {});
  const providerConfig = provider.resolveConfig
    ? provider.resolveConfig({ cfg: params.fullConfig, rawConfig })
    : rawConfig;
  if (!provider.isConfigured({ cfg: params.fullConfig, providerConfig })) {
    throw new Error(`Realtime transcription provider "${provider.id}" is not configured`);
  }
  return { provider, providerConfig };
}

function buildGoogleMeetSpeakExactUserMessage(text: string): string {
  return [
    "Speak this exact OpenClaw answer to the meeting, without adding, removing, or rephrasing words.",
    `Answer: ${JSON.stringify(text)}`,
  ].join("\n");
}

function readLogString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function formatLogValue(value: string | undefined): string {
  const normalized = value ? truncateUtf16Safe(value.replace(/\s+/g, "_"), 180) : undefined;
  return normalized || "unknown";
}

function resolveProviderModelForLog(params: {
  provider: { defaultModel?: string };
  providerConfig: RealtimeVoiceProviderConfig | RealtimeTranscriptionProviderConfig;
  fallbackModel?: string;
}): string {
  return (
    readLogString(params.providerConfig.model) ??
    readLogString(params.providerConfig.modelId) ??
    readLogString(params.fallbackModel) ??
    readLogString(params.provider.defaultModel) ??
    "provider-default"
  );
}

function formatGoogleMeetRealtimeVoiceModelLog(params: {
  strategy: string;
  provider: RealtimeVoiceProviderPlugin;
  providerConfig: RealtimeVoiceProviderConfig;
  fallbackModel?: string;
  audioFormat: GoogleMeetConfig["chrome"]["audioFormat"];
}): string {
  return [
    `[google-meet] realtime voice bridge starting: strategy=${formatLogValue(params.strategy)}`,
    `provider=${formatLogValue(params.provider.id)}`,
    `model=${formatLogValue(
      resolveProviderModelForLog({
        provider: params.provider,
        providerConfig: params.providerConfig,
        fallbackModel: params.fallbackModel,
      }),
    )}`,
    `audioFormat=${formatLogValue(params.audioFormat)}`,
  ].join(" ");
}

function formatGoogleMeetAgentAudioModelLog(params: {
  provider: RealtimeTranscriptionProviderPlugin;
  providerConfig: RealtimeTranscriptionProviderConfig;
  audioFormat: GoogleMeetConfig["chrome"]["audioFormat"];
}): string {
  return [
    `[google-meet] agent audio bridge starting: transcriptionProvider=${formatLogValue(
      params.provider.id,
    )}`,
    `transcriptionModel=${formatLogValue(
      resolveProviderModelForLog({
        provider: params.provider,
        providerConfig: params.providerConfig,
      }),
    )}`,
    "tts=telephony",
    `audioFormat=${formatLogValue(params.audioFormat)}`,
  ].join(" ");
}

type GoogleMeetTtsResultLogFields = {
  provider?: string;
  providerModel?: string;
  providerVoice?: string;
  outputFormat?: string;
  sampleRate?: number;
  fallbackFrom?: string;
};

function formatGoogleMeetAgentTtsResultLog(
  prefix: string,
  result: GoogleMeetTtsResultLogFields,
): string {
  return [
    `[google-meet] ${prefix} TTS: provider=${formatLogValue(result.provider)}`,
    `model=${formatLogValue(result.providerModel)}`,
    `voice=${formatLogValue(result.providerVoice)}`,
    `outputFormat=${formatLogValue(result.outputFormat)}`,
    `sampleRate=${result.sampleRate ?? "unknown"}`,
    ...(result.fallbackFrom ? [`fallbackFrom=${formatLogValue(result.fallbackFrom)}`] : []),
  ].join(" ");
}

function formatGoogleMeetTranscriptSummaryLog(prefix: string, text: string): string {
  return `[google-meet] ${prefix}: chars=${text.length}`;
}

function normalizeGoogleMeetTtsPromptText(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) {
    return undefined;
  }
  const sayExactly = trimmed.match(/^say exactly:\s*(?<text>.+)$/is)?.groups?.text?.trim();
  if (sayExactly) {
    return sayExactly.replace(/^["']|["']$/g, "").trim() || trimmed;
  }
  return trimmed;
}

function pushGoogleMeetTalkEvent(events: TalkEvent[], event: TalkEvent, maxEntries = 40): void {
  events.push(event);
  if (events.length > maxEntries) {
    events.splice(0, events.length - maxEntries);
  }
}

function summarizeGoogleMeetTalkEvents(
  events: TalkEvent[],
): NonNullable<GoogleMeetChromeHealth["recentTalkEvents"]> {
  return events.slice(-20).map((event) => ({
    id: event.id,
    type: event.type,
    sessionId: event.sessionId,
    turnId: event.turnId,
    seq: event.seq,
    timestamp: event.timestamp,
    final: event.final,
  }));
}

export async function startMeetAgentRealtimeEngine(params: {
  config: GoogleMeetConfig;
  fullConfig: OpenClawConfig;
  runtime: PluginRuntime;
  meetingSessionId: string;
  requesterSessionKey?: string;
  logPrefix?: "node";
  transport: MeetRealtimeAudioTransport;
  logger: RuntimeLogger;
  providers?: RealtimeTranscriptionProviderPlugin[];
}): Promise<MeetRealtimeAudioEngineHandle> {
  let stopped = false;
  let sttSession: RealtimeTranscriptionSession | null = null;
  let realtimeReady = false;
  let lastInputAt: string | undefined;
  let lastOutputAt: string | undefined;
  let lastInputBytes = 0;
  const outputActivity = createRealtimeVoiceOutputActivityTracker();
  let suppressedInputBytes = 0;
  let lastSuppressedInputAt: string | undefined;
  let suppressInputUntil = 0;
  let lastOutputPlayableUntilMs = 0;
  let ttsQueue = Promise.resolve();
  const transcript: GoogleMeetRealtimeTranscriptEntry[] = [];
  const agentLogScope = params.logPrefix ? `${params.logPrefix} agent` : "agent";
  const resolved = resolveGoogleMeetRealtimeTranscriptionProvider({
    config: params.config,
    fullConfig: params.fullConfig,
    providers: params.providers,
  });
  const talk = createTalkSessionController(
    {
      sessionId: `google-meet:${params.meetingSessionId}:agent`,
      mode: "stt-tts",
      transport: "gateway-relay",
      brain: "agent-consult",
      provider: resolved.provider.id,
      turnIdPrefix: `google-meet:${params.meetingSessionId}:turn`,
    },
    { onEvent: recordTalkObservabilityEvent },
  );
  const recentTalkEvents: TalkEvent[] = [];
  const emitTalkEvent = (inputResult: TalkEventInput) =>
    pushGoogleMeetTalkEvent(recentTalkEvents, talk.emit(inputResult));
  const ensureTalkTurn = () => {
    const turn = talk.ensureTurn({
      payload: { meetingSessionId: params.meetingSessionId },
    });
    if (turn.event) {
      pushGoogleMeetTalkEvent(recentTalkEvents, turn.event);
    }
    return turn.turnId;
  };
  const endTalkTurn = () => {
    const ended = talk.endTurn({
      payload: { meetingSessionId: params.meetingSessionId },
    });
    if (ended.ok) {
      pushGoogleMeetTalkEvent(recentTalkEvents, ended.event);
    }
  };
  params.logger.info(
    formatGoogleMeetAgentAudioModelLog({
      provider: resolved.provider,
      providerConfig: resolved.providerConfig,
      audioFormat: params.config.chrome.audioFormat,
    }),
  );

  const stop = async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    agentTalkback?.close();
    try {
      sttSession?.close();
    } catch (error) {
      params.logger.debug?.(
        `[google-meet] ${agentLogScope} transcription bridge close ignored: ${formatErrorMessage(error)}`,
      );
    }
    emitTalkEvent({
      type: "session.closed",
      final: true,
      payload: { meetingSessionId: params.meetingSessionId },
    });
    await params.transport.stop();
    await params.transport.dispose();
  };

  const writeOutputAudio = async (audio: Buffer) => {
    const suppression = recordGoogleMeetOutputActivity({
      tracker: outputActivity,
      audio,
      audioFormat: params.config.chrome.audioFormat,
      nowMs: Date.now(),
      lastOutputPlayableUntilMs,
      suppressInputUntilMs: suppressInputUntil,
    });
    suppressInputUntil = suppression.suppressInputUntilMs;
    lastOutputPlayableUntilMs = suppression.lastOutputPlayableUntilMs;
    lastOutputAt = new Date().toISOString();
    emitTalkEvent({
      type: "output.audio.delta",
      turnId: ensureTalkTurn(),
      payload: { meetingSessionId: params.meetingSessionId, bytes: audio.byteLength },
    });
    await params.transport.writeOutput(audio);
  };

  const enqueueSpeakText = (text: string | undefined) => {
    const normalized = normalizeGoogleMeetTtsPromptText(text);
    if (!normalized || stopped) {
      return;
    }
    ttsQueue = ttsQueue
      .then(async () => {
        if (stopped) {
          return;
        }
        recordGoogleMeetRealtimeTranscript(transcript, "assistant", normalized);
        params.logger.info(
          formatGoogleMeetTranscriptSummaryLog(`${agentLogScope} assistant`, normalized),
        );
        const turnId = ensureTalkTurn();
        emitTalkEvent({
          type: "output.text.done",
          turnId,
          final: true,
          payload: { meetingSessionId: params.meetingSessionId, text: normalized },
        });
        const result = await params.runtime.tts.textToSpeechTelephony({
          text: normalized,
          cfg: params.fullConfig,
        });
        if (!result.success || !result.audioBuffer || !result.sampleRate) {
          throw new Error(result.error ?? "TTS conversion failed");
        }
        params.logger.info(formatGoogleMeetAgentTtsResultLog(agentLogScope, result));
        emitTalkEvent({
          type: "output.audio.started",
          turnId,
          payload: { meetingSessionId: params.meetingSessionId },
        });
        await writeOutputAudio(
          convertGoogleMeetTtsAudioForBridge(
            result.audioBuffer,
            result.sampleRate,
            params.config,
            result.outputFormat,
          ),
        );
        emitTalkEvent({
          type: "output.audio.done",
          turnId,
          final: true,
          payload: { meetingSessionId: params.meetingSessionId },
        });
        endTalkTurn();
      })
      .catch((error: unknown) => {
        params.logger.warn(
          `[google-meet] ${agentLogScope} TTS failed: ${formatErrorMessage(error)}`,
        );
      });
  };

  const agentTalkback: RealtimeVoiceAgentTalkbackQueue | undefined =
    createRealtimeVoiceAgentTalkbackQueue({
      debounceMs: GOOGLE_MEET_AGENT_TRANSCRIPT_DEBOUNCE_MS,
      isStopped: () => stopped,
      logger: params.logger,
      logPrefix: `[google-meet] ${agentLogScope}`,
      responseStyle: "Brief, natural spoken answer for a live meeting.",
      fallbackText: "I hit an error while checking that. Please try again.",
      consult: ({ question, responseStyle }) =>
        consultOpenClawAgentForGoogleMeet({
          config: params.config,
          fullConfig: params.fullConfig,
          runtime: params.runtime,
          logger: params.logger,
          meetingSessionId: params.meetingSessionId,
          requesterSessionKey: params.requesterSessionKey,
          args: { question, responseStyle },
          transcript,
        }),
      deliver: enqueueSpeakText,
    });

  params.transport.onFatal(() => {
    void stop();
  });
  // onFatal replays a pre-registration failure synchronously; abort before creating a
  // provider session that the already-completed stop() could never close.
  if (stopped) {
    throw new Error("Google Meet audio transport failed before transcription provider setup");
  }

  sttSession = resolved.provider.createSession({
    cfg: params.fullConfig,
    providerConfig: resolved.providerConfig,
    onTranscript: (text) => {
      const trimmed = text.trim();
      if (!trimmed || stopped) {
        return;
      }
      const turnId = ensureTalkTurn();
      emitTalkEvent({
        type: "input.audio.committed",
        turnId,
        final: true,
        payload: { meetingSessionId: params.meetingSessionId },
      });
      emitTalkEvent({
        type: "transcript.done",
        turnId,
        final: true,
        payload: { meetingSessionId: params.meetingSessionId, text: trimmed, role: "user" },
      });
      recordGoogleMeetRealtimeTranscript(transcript, "user", trimmed);
      params.logger.info(formatGoogleMeetTranscriptSummaryLog(`${agentLogScope} user`, trimmed));
      if (isGoogleMeetLikelyAssistantEchoTranscript({ transcript, text: trimmed })) {
        params.logger.info(
          formatGoogleMeetTranscriptSummaryLog(
            `${agentLogScope} ignored assistant echo transcript`,
            trimmed,
          ),
        );
        return;
      }
      agentTalkback?.enqueue(trimmed);
    },
    onError: (error) => {
      params.logger.warn(
        `[google-meet] ${agentLogScope} transcription bridge failed: ${formatErrorMessage(error)}`,
      );
      emitTalkEvent({
        type: "session.error",
        final: true,
        payload: { meetingSessionId: params.meetingSessionId, error: formatErrorMessage(error) },
      });
      void stop();
    },
  });

  emitTalkEvent({
    type: "session.started",
    payload: { meetingSessionId: params.meetingSessionId, provider: resolved.provider.id },
  });
  // Drain transport input while connect() is pending so the capture pipe never backpressures;
  // chunks before session.ready are dropped instead of arriving later as a stale burst.
  params.transport.startInput((audio) => {
    if (stopped || !realtimeReady || audio.byteLength === 0) {
      return;
    }
    if (Date.now() < suppressInputUntil) {
      lastSuppressedInputAt = new Date().toISOString();
      suppressedInputBytes += audio.byteLength;
      return;
    }
    lastInputAt = new Date().toISOString();
    lastInputBytes += audio.byteLength;
    emitTalkEvent({
      type: "input.audio.delta",
      turnId: ensureTalkTurn(),
      payload: { meetingSessionId: params.meetingSessionId, bytes: audio.byteLength },
    });
    sttSession?.sendAudio(convertGoogleMeetBridgeAudioForStt(audio, params.config));
  });

  await sttSession.connect();
  if (stopped) {
    throw new Error("Google Meet audio transport stopped during transcription provider setup");
  }
  realtimeReady = true;
  emitTalkEvent({
    type: "session.ready",
    payload: { meetingSessionId: params.meetingSessionId },
  });

  return {
    providerId: resolved.provider.id,
    speak: enqueueSpeakText,
    getHealth: () => ({
      providerConnected: sttSession?.isConnected() ?? false,
      realtimeReady,
      audioInputActive: lastInputBytes > 0,
      audioOutputActive: outputActivity.isActive(),
      lastInputAt,
      lastOutputAt,
      lastSuppressedInputAt,
      lastInputBytes,
      lastOutputBytes: outputActivity.snapshot().sinkAudioBytes,
      suppressedInputBytes,
      ...params.transport.getHealth?.(),
      ...getGoogleMeetRealtimeTranscriptHealth(transcript),
      recentTalkEvents: summarizeGoogleMeetTalkEvents(recentTalkEvents),
      bridgeClosed: stopped,
    }),
    stop,
  };
}

export async function startMeetRealtimeEngine(params: {
  config: GoogleMeetConfig;
  fullConfig: OpenClawConfig;
  runtime: PluginRuntime;
  meetingSessionId: string;
  requesterSessionKey?: string;
  logPrefix?: "node";
  talkSessionId?: string;
  talkContext?: { nodeId: string; bridgeId: string };
  transport: MeetRealtimeAudioTransport;
  logger: RuntimeLogger;
  providers?: RealtimeVoiceProviderPlugin[];
}): Promise<MeetRealtimeAudioEngineHandle> {
  let stopped = false;
  let bridge: RealtimeVoiceBridgeSession | null = null;
  let realtimeReady = false;
  let lastInputAt: string | undefined;
  let lastOutputAt: string | undefined;
  let lastInputBytes = 0;
  const outputActivity = createRealtimeVoiceOutputActivityTracker();
  let lastClearAt: string | undefined;
  let clearCount = 0;
  let suppressedInputBytes = 0;
  let lastSuppressedInputAt: string | undefined;
  let suppressInputUntil = 0;
  let lastOutputPlayableUntilMs = 0;
  const realtimeLogScope = params.logPrefix ? `${params.logPrefix} realtime` : "realtime";

  const suppressInputForOutput = (audio: Buffer) => {
    const suppression = recordGoogleMeetOutputActivity({
      tracker: outputActivity,
      audio,
      audioFormat: params.config.chrome.audioFormat,
      nowMs: Date.now(),
      lastOutputPlayableUntilMs,
      suppressInputUntilMs: suppressInputUntil,
    });
    suppressInputUntil = suppression.suppressInputUntilMs;
    lastOutputPlayableUntilMs = suppression.lastOutputPlayableUntilMs;
  };

  const stop = async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    agentTalkback?.close();
    try {
      bridge?.close();
    } catch (error) {
      params.logger.debug?.(
        `[google-meet] ${realtimeLogScope}${params.logPrefix ? "" : " voice"} bridge close ignored: ${formatErrorMessage(error)}`,
      );
    }
    await params.transport.stop();
    await params.transport.dispose();
  };
  const clearOutputPlayback = () => {
    if (stopped) {
      return;
    }
    clearCount += 1;
    lastClearAt = new Date().toISOString();
    suppressInputUntil = 0;
    lastOutputPlayableUntilMs = 0;
    void params.transport.clearOutput().catch((error: unknown) => {
      params.logger.warn(
        `[google-meet] ${params.logPrefix ? `${params.logPrefix} audio clear` : "audio output clear"} failed: ${formatErrorMessage(error)}`,
      );
      void stop();
    });
  };
  const writeOutputAudio = (audio: Buffer) => {
    void params.transport.writeOutput(audio).catch((error: unknown) => {
      params.logger.warn(
        `[google-meet] ${params.logPrefix ? `${params.logPrefix} audio output` : "audio output"} failed: ${formatErrorMessage(error)}`,
      );
      void stop();
    });
  };
  const startHumanBargeInMonitor = () => {
    if (!params.transport.startBargeInMonitor) {
      return;
    }
    params.transport.startBargeInMonitor(() => {
      if (stopped || !outputActivity.isInterruptible()) {
        return false;
      }
      const now = Date.now();
      const playbackActive = now <= Math.max(lastOutputPlayableUntilMs, suppressInputUntil);
      const lastOutputAudioAt = outputActivity.snapshot().lastAudioAt;
      if (!playbackActive && (lastOutputAudioAt === undefined || now - lastOutputAudioAt > 1_000)) {
        return false;
      }
      suppressInputUntil = 0;
      const beforeClearCount = clearCount;
      bridge?.handleBargeIn({ audioPlaybackActive: true });
      // Provider clear callbacks normally flush; this fallback keeps barge-in and playback coupled.
      if (beforeClearCount === clearCount) {
        clearOutputPlayback();
      }
      return true;
    });
  };

  const resolved = resolveGoogleMeetRealtimeProvider({
    config: params.config,
    fullConfig: params.fullConfig,
    providers: params.providers,
  });
  const strategy = params.config.realtime.strategy;
  params.logger.info(
    formatGoogleMeetRealtimeVoiceModelLog({
      strategy,
      provider: resolved.provider,
      providerConfig: resolved.providerConfig,
      fallbackModel: params.config.realtime.model,
      audioFormat: params.config.chrome.audioFormat,
    }),
  );
  const transcript: GoogleMeetRealtimeTranscriptEntry[] = [];
  const realtimeEvents: GoogleMeetRealtimeEventEntry[] = [];
  const talk: TalkSessionController = createTalkSessionController(
    {
      sessionId: params.talkSessionId ?? `google-meet:${params.meetingSessionId}:command-realtime`,
      mode: "realtime",
      transport: "gateway-relay",
      brain: strategy === "bidi" ? "direct-tools" : "agent-consult",
      provider: resolved.provider.id,
    },
    { onEvent: recordTalkObservabilityEvent },
  );
  const recentTalkEvents: TalkEvent[] = [];
  const meetingTalkPayload = params.talkContext
    ? { bridgeId: params.talkContext.bridgeId, meetingSessionId: params.meetingSessionId }
    : { meetingSessionId: params.meetingSessionId };
  const outputTalkPayload = params.talkContext
    ? { bridgeId: params.talkContext.bridgeId }
    : { meetingSessionId: params.meetingSessionId };
  const reasonTalkPayload = (reason: string) =>
    params.talkContext ? { bridgeId: params.talkContext.bridgeId, reason } : { reason };
  const rememberTalkEvent = (event: TalkEvent | undefined): void => {
    if (event) {
      pushGoogleMeetTalkEvent(recentTalkEvents, event);
    }
  };
  const emitTalkEvent = (inputValue: TalkEventInput): void => {
    rememberTalkEvent(talk.emit(inputValue));
  };
  const ensureTalkTurn = (): string => {
    const turn = talk.ensureTurn({
      payload: meetingTalkPayload,
    });
    if (turn.event) {
      rememberTalkEvent(turn.event);
    }
    return turn.turnId;
  };
  const finishOutputAudio = (reason: string): void => {
    rememberTalkEvent(
      talk.finishOutputAudio({
        payload: reasonTalkPayload(reason),
      }),
    );
  };
  const endTalkTurn = (reason = "completed"): void => {
    const ended = talk.endTurn({
      payload: reasonTalkPayload(reason),
    });
    if (ended.ok) {
      rememberTalkEvent(ended.event);
    }
  };
  emitTalkEvent({
    type: "session.started",
    payload: params.talkContext
      ? { ...meetingTalkPayload, nodeId: params.talkContext.nodeId }
      : meetingTalkPayload,
  });
  const agentTalkback: RealtimeVoiceAgentTalkbackQueue | undefined =
    createRealtimeVoiceAgentTalkbackQueue({
      debounceMs: GOOGLE_MEET_AGENT_TRANSCRIPT_DEBOUNCE_MS,
      isStopped: () => stopped,
      logger: params.logger,
      logPrefix: `[google-meet] ${realtimeLogScope} agent`,
      responseStyle: "Brief, natural spoken answer for a live meeting.",
      fallbackText: "I hit an error while checking that. Please try again.",
      consult: ({ question, responseStyle }) =>
        consultOpenClawAgentForGoogleMeet({
          config: params.config,
          fullConfig: params.fullConfig,
          runtime: params.runtime,
          logger: params.logger,
          meetingSessionId: params.meetingSessionId,
          requesterSessionKey: params.requesterSessionKey,
          args: { question, responseStyle },
          transcript,
        }),
      deliver: (text) => {
        bridge?.sendUserMessage(buildGoogleMeetSpeakExactUserMessage(text));
      },
    });
  params.transport.onFatal(() => {
    void stop();
  });
  // onFatal replays a pre-registration failure synchronously; abort before creating a
  // voice bridge that the already-completed stop() could never close.
  if (stopped) {
    throw new Error("Google Meet audio transport failed before realtime provider setup");
  }
  bridge = createRealtimeVoiceBridgeSession({
    provider: resolved.provider,
    cfg: params.fullConfig,
    providerConfig: resolved.providerConfig,
    audioFormat: resolveGoogleMeetRealtimeAudioFormat(params.config),
    instructions: params.config.realtime.instructions,
    initialGreetingInstructions: params.config.realtime.introMessage,
    autoRespondToAudio: strategy === "bidi",
    triggerGreetingOnReady: false,
    markStrategy: "ack-immediately",
    tools:
      strategy === "bidi" ? resolveGoogleMeetRealtimeTools(params.config.realtime.toolPolicy) : [],
    audioSink: {
      isOpen: () => !stopped,
      sendAudio: (audio) => {
        const turnId = ensureTalkTurn();
        rememberTalkEvent(
          talk.startOutputAudio({
            turnId,
            payload: outputTalkPayload,
          }).event,
        );
        emitTalkEvent({
          type: "output.audio.delta",
          turnId,
          payload: { byteLength: audio.byteLength },
        });
        lastOutputAt = new Date().toISOString();
        suppressInputForOutput(audio);
        writeOutputAudio(audio);
      },
      clearAudio: () => {
        clearOutputPlayback();
        finishOutputAudio("clear");
      },
    },
    onTranscript: (role, text, isFinal) => {
      const turnId = ensureTalkTurn();
      const eventType =
        role === "assistant"
          ? isFinal
            ? "output.text.done"
            : "output.text.delta"
          : isFinal
            ? "transcript.done"
            : "transcript.delta";
      const payload = role === "assistant" ? { text } : { role, text };
      emitTalkEvent({
        type: eventType,
        turnId,
        payload,
        final: isFinal,
      });
      if (role === "user" && isFinal) {
        emitTalkEvent({
          type: "input.audio.committed",
          turnId,
          payload: outputTalkPayload,
          final: true,
        });
      }
      if (isFinal) {
        recordGoogleMeetRealtimeTranscript(transcript, role, text);
        params.logger.info(
          formatGoogleMeetTranscriptSummaryLog(`${realtimeLogScope} ${role}`, text),
        );
        if (role === "user" && strategy === "agent") {
          if (isGoogleMeetLikelyAssistantEchoTranscript({ transcript, text })) {
            params.logger.info(
              formatGoogleMeetTranscriptSummaryLog(
                `${realtimeLogScope} ignored assistant echo transcript`,
                text,
              ),
            );
            return;
          }
          agentTalkback?.enqueue(text);
        }
      }
    },
    onEvent: (event) => {
      recordGoogleMeetRealtimeEvent(realtimeEvents, event);
      if (event.type === "input_audio_buffer.speech_started") {
        ensureTalkTurn();
      } else if (event.type === "input_audio_buffer.speech_stopped") {
        const turnId = talk.activeTurnId;
        if (!turnId) {
          return;
        }
        emitTalkEvent({
          type: "input.audio.committed",
          turnId,
          payload: { ...outputTalkPayload, source: event.type },
          final: true,
        });
      } else if (event.type === "response.done") {
        finishOutputAudio("response.done");
        endTalkTurn("response.done");
      } else if (event.type === "error") {
        emitTalkEvent({
          type: "session.error",
          payload: { message: event.detail ?? "Realtime provider error" },
          final: true,
        });
      }
      if (
        event.type === "error" ||
        event.type === "response.done" ||
        event.type === "input_audio_buffer.speech_started" ||
        event.type === "input_audio_buffer.speech_stopped" ||
        event.type === "conversation.item.input_audio_transcription.completed" ||
        event.type === "conversation.item.input_audio_transcription.failed"
      ) {
        const detail = event.detail ? ` ${event.detail}` : "";
        params.logger.info(
          `[google-meet] ${realtimeLogScope} ${event.direction}:${event.type}${detail}`,
        );
      }
    },
    onToolCall: (event, session) => {
      emitTalkEvent({
        type: "tool.call",
        turnId: ensureTalkTurn(),
        itemId: event.itemId,
        callId: event.callId,
        payload: { name: event.name, args: event.args },
      });
      const turnId = ensureTalkTurn();
      return handleGoogleMeetRealtimeConsultToolCall({
        strategy,
        session,
        event,
        config: params.config,
        fullConfig: params.fullConfig,
        runtime: params.runtime,
        logger: params.logger,
        meetingSessionId: params.meetingSessionId,
        requesterSessionKey: params.requesterSessionKey,
        transcript,
        onTalkEvent: (inputLocal) =>
          emitTalkEvent({ ...inputLocal, turnId: inputLocal.turnId ?? turnId }),
      });
    },
    onError: (error) => {
      emitTalkEvent({
        type: "session.error",
        payload: { message: formatErrorMessage(error) },
        final: true,
      });
      params.logger.warn(
        `[google-meet] ${realtimeLogScope} voice bridge failed: ${formatErrorMessage(error)}`,
      );
      void stop();
    },
    onClose: (reason) => {
      realtimeReady = false;
      finishOutputAudio(reason);
      emitTalkEvent({
        type: "session.closed",
        payload: { reason },
        final: true,
      });
      if (reason === "error") {
        void stop();
      }
    },
    onReady: () => {
      realtimeReady = true;
      emitTalkEvent({
        type: "session.ready",
        payload: outputTalkPayload,
      });
    },
  });
  startHumanBargeInMonitor();

  // Drain transport input while connect() is pending so the capture pipe never backpressures.
  // Pre-connect audio is forwarded; the voice bridge owns buffering, matching the previous
  // local command-pair behavior.
  params.transport.startInput((audio) => {
    if (stopped || audio.byteLength === 0) {
      return;
    }
    if (Date.now() < suppressInputUntil) {
      lastSuppressedInputAt = new Date().toISOString();
      suppressedInputBytes += audio.byteLength;
      return;
    }
    lastInputAt = new Date().toISOString();
    lastInputBytes += audio.byteLength;
    emitTalkEvent({
      type: "input.audio.delta",
      turnId: ensureTalkTurn(),
      payload: { byteLength: audio.byteLength },
    });
    bridge?.sendAudio(audio);
  });

  await bridge.connect();
  if (stopped) {
    throw new Error("Google Meet audio transport stopped during realtime provider setup");
  }

  return {
    providerId: resolved.provider.id,
    speak: (instructions) => {
      bridge?.triggerGreeting(instructions);
    },
    getHealth: () => ({
      providerConnected: bridge?.bridge.isConnected() ?? false,
      realtimeReady,
      audioInputActive: lastInputBytes > 0,
      audioOutputActive: outputActivity.isActive(),
      lastInputAt,
      lastOutputAt,
      lastSuppressedInputAt,
      lastInputBytes,
      lastOutputBytes: outputActivity.snapshot().sinkAudioBytes,
      suppressedInputBytes,
      ...params.transport.getHealth?.(),
      ...getGoogleMeetRealtimeTranscriptHealth(transcript),
      ...getGoogleMeetRealtimeEventHealth(realtimeEvents),
      recentTalkEvents: summarizeGoogleMeetTalkEvents(recentTalkEvents),
      lastClearAt,
      clearCount,
      bridgeClosed: stopped,
    }),
    stop,
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
