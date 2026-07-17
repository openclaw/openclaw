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
  createRealtimeVoiceSessionHarness,
  resolveConfiguredRealtimeVoiceProvider,
  type RealtimeVoiceBridgeSession,
  type RealtimeVoiceProviderConfig,
  type RealtimeVoiceProviderPlugin,
  type RealtimeVoiceSessionHarness,
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

const GOOGLE_MEET_AGENT_TRANSCRIPT_DEBOUNCE_MS = 900;
// Playback duration plus a tail blocks live loopback; transcript lookback catches delayed echo.
const GOOGLE_MEET_OUTPUT_ECHO_SUPPRESSION_TAIL_MS = 3_000;
const GOOGLE_MEET_TRANSCRIPT_ECHO_LOOKBACK_MS = 45_000;

function googleMeetOutputBytesPerMs(
  audioFormat: GoogleMeetConfig["chrome"]["audioFormat"],
): number {
  return audioFormat === "g711-ulaw-8khz" ? 8 : 48;
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
  let ttsQueue = Promise.resolve();
  const agentLogScope = params.logPrefix ? `${params.logPrefix} agent` : "agent";
  const resolved = resolveGoogleMeetRealtimeTranscriptionProvider({
    config: params.config,
    fullConfig: params.fullConfig,
    providers: params.providers,
  });
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
    harness.close();
    try {
      sttSession?.close();
    } catch (error) {
      params.logger.debug?.(
        `[google-meet] ${agentLogScope} transcription bridge close ignored: ${formatErrorMessage(error)}`,
      );
    }
    harness.emit({
      type: "session.closed",
      final: true,
      payload: { meetingSessionId: params.meetingSessionId },
    });
    await params.transport.stop();
    await params.transport.dispose();
  };

  const writeOutputAudio = async (audio: Buffer) => {
    harness.outputActivity.markPlaybackStarted();
    harness.recordOutputAudio(audio);
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
        harness.recordTranscript("assistant", normalized);
        params.logger.info(
          formatGoogleMeetTranscriptSummaryLog(`${agentLogScope} assistant`, normalized),
        );
        const turnId = harness.ensureTurn();
        harness.emit({
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
        await writeOutputAudio(
          convertGoogleMeetTtsAudioForBridge(
            result.audioBuffer,
            result.sampleRate,
            params.config,
            result.outputFormat,
          ),
        );
        harness.finishOutputAudio("completed");
        harness.endTurn();
      })
      .catch((error: unknown) => {
        params.logger.warn(
          `[google-meet] ${agentLogScope} TTS failed: ${formatErrorMessage(error)}`,
        );
      });
  };

  // The closures above only run after harness creation; they capture this later `const`.
  // Annotated because the consult closure references harness inside its own initializer.
  const harness: RealtimeVoiceSessionHarness = createRealtimeVoiceSessionHarness({
    talk: {
      sessionId: `google-meet:${params.meetingSessionId}:agent`,
      mode: "stt-tts",
      transport: "gateway-relay",
      brain: "agent-consult",
      provider: resolved.provider.id,
      turnIdPrefix: `google-meet:${params.meetingSessionId}:turn`,
    },
    talkPayloads: {
      turnStarted: () => ({ meetingSessionId: params.meetingSessionId }),
      turnEnded: () => ({ meetingSessionId: params.meetingSessionId }),
      inputAudioDelta: (audio) => ({
        meetingSessionId: params.meetingSessionId,
        bytes: audio.byteLength,
      }),
      outputAudioStarted: () => ({ meetingSessionId: params.meetingSessionId }),
      outputAudioDelta: (audio) => ({
        meetingSessionId: params.meetingSessionId,
        bytes: audio.byteLength,
      }),
      outputAudioDone: () => ({ meetingSessionId: params.meetingSessionId }),
    },
    echoSuppression: {
      bytesPerMs: googleMeetOutputBytesPerMs(params.config.chrome.audioFormat),
      tailMs: GOOGLE_MEET_OUTPUT_ECHO_SUPPRESSION_TAIL_MS,
      transcriptLookbackMs: GOOGLE_MEET_TRANSCRIPT_ECHO_LOOKBACK_MS,
    },
    talkback: {
      debounceMs: GOOGLE_MEET_AGENT_TRANSCRIPT_DEBOUNCE_MS,
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
          transcript: harness.transcript,
        }),
      deliver: enqueueSpeakText,
    },
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
      const turnId = harness.ensureTurn();
      harness.emit({
        type: "input.audio.committed",
        turnId,
        final: true,
        payload: { meetingSessionId: params.meetingSessionId },
      });
      harness.emit({
        type: "transcript.done",
        turnId,
        final: true,
        payload: { meetingSessionId: params.meetingSessionId, text: trimmed, role: "user" },
      });
      harness.recordTranscript("user", trimmed);
      params.logger.info(formatGoogleMeetTranscriptSummaryLog(`${agentLogScope} user`, trimmed));
      if (harness.isLikelyAssistantEchoTranscript(trimmed)) {
        params.logger.info(
          formatGoogleMeetTranscriptSummaryLog(
            `${agentLogScope} ignored assistant echo transcript`,
            trimmed,
          ),
        );
        return;
      }
      harness.talkback?.enqueue(trimmed);
    },
    onError: (error) => {
      params.logger.warn(
        `[google-meet] ${agentLogScope} transcription bridge failed: ${formatErrorMessage(error)}`,
      );
      harness.emit({
        type: "session.error",
        final: true,
        payload: { meetingSessionId: params.meetingSessionId, error: formatErrorMessage(error) },
      });
      void stop();
    },
  });

  harness.emit({
    type: "session.started",
    payload: { meetingSessionId: params.meetingSessionId, provider: resolved.provider.id },
  });
  // Drain transport input while connect() is pending so the capture pipe never backpressures;
  // chunks before session.ready are dropped instead of arriving later as a stale burst.
  params.transport.startInput((audio) => {
    if (stopped || !realtimeReady || audio.byteLength === 0) {
      return;
    }
    if (!harness.recordInputAudio(audio)) {
      return;
    }
    sttSession?.sendAudio(convertGoogleMeetBridgeAudioForStt(audio, params.config));
  });

  await sttSession.connect();
  if (stopped) {
    throw new Error("Google Meet audio transport stopped during transcription provider setup");
  }
  realtimeReady = true;
  harness.emit({
    type: "session.ready",
    payload: { meetingSessionId: params.meetingSessionId },
  });

  return {
    providerId: resolved.provider.id,
    speak: enqueueSpeakText,
    getHealth: () => ({
      ...harness.getHealth({
        providerConnected: sttSession?.isConnected() ?? false,
        realtimeReady,
      }),
      ...params.transport.getHealth?.(),
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
  // Not const: the synchronous onFatal replay can run stop() (and its bridge?.close())
  // before createBridge() below executes; a later `const` would throw at that read.
  let bridge: RealtimeVoiceBridgeSession | undefined = undefined;
  let realtimeReady = false;
  let lastClearAt: string | undefined;
  let clearCount = 0;
  const realtimeLogScope = params.logPrefix ? `${params.logPrefix} realtime` : "realtime";

  const stop = async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    harness.close();
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
      if (stopped || !harness.outputActivity.isInterruptible()) {
        return false;
      }
      const now = Date.now();
      const playbackActive = harness.isOutputPlaybackWindowActive();
      const lastOutputAudioAt = harness.outputActivity.snapshot().lastAudioAt;
      if (!playbackActive && (lastOutputAudioAt === undefined || now - lastOutputAudioAt > 1_000)) {
        return false;
      }
      harness.handleBargeIn({ audioPlaybackActive: true }, clearOutputPlayback);
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
  const meetingTalkPayload = params.talkContext
    ? { bridgeId: params.talkContext.bridgeId, meetingSessionId: params.meetingSessionId }
    : { meetingSessionId: params.meetingSessionId };
  const outputTalkPayload = params.talkContext
    ? { bridgeId: params.talkContext.bridgeId }
    : { meetingSessionId: params.meetingSessionId };
  const reasonTalkPayload = (reason: string) =>
    params.talkContext ? { bridgeId: params.talkContext.bridgeId, reason } : { reason };
  // The closures above only run after harness creation; they capture this later `const`.
  // Annotated because the consult closure references harness inside its own initializer.
  const harness: RealtimeVoiceSessionHarness = createRealtimeVoiceSessionHarness({
    talk: {
      sessionId: params.talkSessionId ?? `google-meet:${params.meetingSessionId}:command-realtime`,
      mode: "realtime",
      transport: "gateway-relay",
      brain: strategy === "bidi" ? "direct-tools" : "agent-consult",
      provider: resolved.provider.id,
    },
    talkPayloads: {
      turnStarted: () => meetingTalkPayload,
      turnEnded: reasonTalkPayload,
      inputAudioDelta: (audio) => ({ byteLength: audio.byteLength }),
      outputAudioStarted: () => outputTalkPayload,
      outputAudioDelta: (audio) => ({ byteLength: audio.byteLength }),
      outputAudioDone: reasonTalkPayload,
    },
    echoSuppression: {
      bytesPerMs: googleMeetOutputBytesPerMs(params.config.chrome.audioFormat),
      tailMs: GOOGLE_MEET_OUTPUT_ECHO_SUPPRESSION_TAIL_MS,
      transcriptLookbackMs: GOOGLE_MEET_TRANSCRIPT_ECHO_LOOKBACK_MS,
    },
    talkback: {
      debounceMs: GOOGLE_MEET_AGENT_TRANSCRIPT_DEBOUNCE_MS,
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
          transcript: harness.transcript,
        }),
      deliver: (text) => {
        bridge?.sendUserMessage(buildGoogleMeetSpeakExactUserMessage(text));
      },
    },
  });
  harness.emit({
    type: "session.started",
    payload: params.talkContext
      ? { ...meetingTalkPayload, nodeId: params.talkContext.nodeId }
      : meetingTalkPayload,
  });
  params.transport.onFatal(() => {
    void stop();
  });
  // onFatal replays a pre-registration failure synchronously; abort before creating a
  // voice bridge that the already-completed stop() could never close.
  if (stopped) {
    throw new Error("Google Meet audio transport failed before realtime provider setup");
  }
  bridge = harness.createBridge({
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
        harness.outputActivity.markPlaybackStarted();
        harness.recordOutputAudio(audio);
        writeOutputAudio(audio);
      },
      clearAudio: () => {
        harness.flushOutput(clearOutputPlayback);
        harness.finishOutputAudio("clear");
      },
    },
    onTranscript: (role, text, isFinal) => {
      const turnId = harness.ensureTurn();
      const eventType =
        role === "assistant"
          ? isFinal
            ? "output.text.done"
            : "output.text.delta"
          : isFinal
            ? "transcript.done"
            : "transcript.delta";
      const payload = role === "assistant" ? { text } : { role, text };
      harness.emit({
        type: eventType,
        turnId,
        payload,
        final: isFinal,
      });
      if (role === "user" && isFinal) {
        harness.emit({
          type: "input.audio.committed",
          turnId,
          payload: outputTalkPayload,
          final: true,
        });
      }
      if (isFinal) {
        params.logger.info(
          formatGoogleMeetTranscriptSummaryLog(`${realtimeLogScope} ${role}`, text),
        );
        if (role === "user" && strategy === "agent") {
          if (harness.isLikelyAssistantEchoTranscript(text)) {
            params.logger.info(
              formatGoogleMeetTranscriptSummaryLog(
                `${realtimeLogScope} ignored assistant echo transcript`,
                text,
              ),
            );
            return;
          }
          harness.talkback?.enqueue(text);
        }
      }
    },
    onEvent: (event) => {
      if (event.type === "input_audio_buffer.speech_started") {
        harness.ensureTurn();
      } else if (event.type === "input_audio_buffer.speech_stopped") {
        const turnId = harness.talk.activeTurnId;
        if (!turnId) {
          return;
        }
        harness.emit({
          type: "input.audio.committed",
          turnId,
          payload: { ...outputTalkPayload, source: event.type },
          final: true,
        });
      } else if (event.type === "response.done") {
        harness.finishOutputAudio("response.done");
        harness.endTurn("response.done");
      } else if (event.type === "error") {
        harness.emit({
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
      harness.emit({
        type: "tool.call",
        turnId: harness.ensureTurn(),
        itemId: event.itemId,
        callId: event.callId,
        payload: { name: event.name, args: event.args },
      });
      const turnId = harness.ensureTurn();
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
        transcript: harness.transcript,
        onTalkEvent: (inputLocal) =>
          harness.emit({ ...inputLocal, turnId: inputLocal.turnId ?? turnId }),
      });
    },
    onError: (error) => {
      harness.emit({
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
      harness.finishOutputAudio(reason);
      harness.emit({
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
      harness.emit({
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
    if (!harness.recordInputAudio(audio)) {
      return;
    }
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
      ...harness.getHealth({
        providerConnected: bridge?.bridge.isConnected() ?? false,
        realtimeReady,
      }),
      ...params.transport.getHealth?.(),
      lastClearAt,
      clearCount,
      bridgeClosed: stopped,
    }),
    stop,
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
