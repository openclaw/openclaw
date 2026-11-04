import type { PluginCapabilityCatalogContext } from "openclaw/plugin-sdk/plugin-entry";
import { createFiniteRealtimeTranscriptionSession } from "openclaw/plugin-sdk/realtime-transcription-session";
import type {
  RealtimeTranscriptionProviderConfig,
  RealtimeTranscriptionProviderPlugin,
  RealtimeTranscriptionSession,
  RealtimeTranscriptionSessionCreateRequest,
  RealtimeTranscriptionWebSocketTransport,
} from "openclaw/plugin-sdk/realtime-transcription-session";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import {
  asFiniteNumberInRange,
  asOptionalRecord as readRecord,
  asSafeIntegerInRange,
  normalizeOptionalString,
  parseFiniteNumber as readFiniteNumber,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveElevenLabsApiKeyWithProfileFallback } from "./config-api.js";
import { normalizeElevenLabsRealtimeBaseUrl } from "./shared.js";

type ElevenLabsRealtimeTranscriptionEvent = {
  message_type?: string;
  text?: string;
  error?: string;
  message?: string;
  code?: string;
};

const ELEVENLABS_REALTIME_DEFAULT_MODEL = "scribe_v2_realtime";
const ELEVENLABS_REALTIME_DEFAULT_AUDIO_FORMAT = "ulaw_8000";
const ELEVENLABS_REALTIME_DEFAULT_SAMPLE_RATE = 8000;
const ELEVENLABS_REALTIME_DEFAULT_COMMIT_STRATEGY: "manual" | "vad" = "vad";

function readNestedElevenLabsConfig(rawConfig: RealtimeTranscriptionProviderConfig) {
  const raw = readRecord(rawConfig);
  const providers = readRecord(raw?.providers);
  return readRecord(providers?.elevenlabs ?? raw?.elevenlabs ?? raw) ?? {};
}

function normalizeCommitStrategy(value: unknown): "manual" | "vad" | undefined {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "manual" || normalized === "vad") {
    return normalized;
  }
  throw new Error(`Invalid ElevenLabs realtime transcription commit strategy: ${normalized}`);
}

function normalizePositiveSafeInteger(value: unknown): number | undefined {
  const parsed = readFiniteNumber(value);
  return asSafeIntegerInRange(parsed, { min: 1 });
}

function normalizeFiniteRange(value: unknown, min: number, max: number): number | undefined {
  const parsed = readFiniteNumber(value);
  return asFiniteNumberInRange(parsed, { min, max });
}

function normalizeMinimumDurationMs(value: unknown): number | undefined {
  const parsed = readFiniteNumber(value);
  return asSafeIntegerInRange(parsed, { min: 50, max: 2_000 });
}

function normalizeProviderConfig(config: RealtimeTranscriptionProviderConfig) {
  const raw = readNestedElevenLabsConfig(config);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw.apiKey,
      path: "plugins.entries.voice-call.config.streaming.providers.elevenlabs.apiKey",
    }),
    baseUrl: normalizeOptionalString(raw.baseUrl),
    modelId: normalizeOptionalString(raw.modelId ?? raw.model ?? raw.sttModel),
    audioFormat: normalizeOptionalString(raw.audioFormat ?? raw.audio_format ?? raw.encoding),
    sampleRate: normalizePositiveSafeInteger(raw.sampleRate ?? raw.sample_rate),
    languageCode: normalizeOptionalString(raw.languageCode ?? raw.language),
    commitStrategy: normalizeCommitStrategy(raw.commitStrategy ?? raw.commit_strategy),
    vadSilenceThresholdSecs: normalizeFiniteRange(
      raw.vadSilenceThresholdSecs ?? raw.vad_silence_threshold_secs,
      0.3,
      3,
    ),
    vadThreshold: normalizeFiniteRange(raw.vadThreshold ?? raw.vad_threshold, 0.1, 0.9),
    minSpeechDurationMs: normalizeMinimumDurationMs(
      raw.minSpeechDurationMs ?? raw.min_speech_duration_ms,
    ),
    minSilenceDurationMs: normalizeMinimumDurationMs(
      raw.minSilenceDurationMs ?? raw.min_silence_duration_ms,
    ),
  };
}

function readErrorDetail(event: ElevenLabsRealtimeTranscriptionEvent): string {
  return (
    normalizeOptionalString(event.error) ??
    normalizeOptionalString(event.message) ??
    normalizeOptionalString(event.code) ??
    "ElevenLabs realtime transcription error"
  );
}

function toElevenLabsRealtimeWsUrl(config: ReturnType<typeof normalizeProviderConfig>): string {
  const url = new URL(
    `${normalizeElevenLabsRealtimeBaseUrl(config.baseUrl)}/v1/speech-to-text/realtime`,
  );
  url.searchParams.set("model_id", config.modelId ?? ELEVENLABS_REALTIME_DEFAULT_MODEL);
  url.searchParams.set(
    "audio_format",
    config.audioFormat ?? ELEVENLABS_REALTIME_DEFAULT_AUDIO_FORMAT,
  );
  url.searchParams.set(
    "commit_strategy",
    config.commitStrategy ?? ELEVENLABS_REALTIME_DEFAULT_COMMIT_STRATEGY,
  );
  url.searchParams.set("include_timestamps", "false");
  url.searchParams.set("include_language_detection", "false");
  if (config.languageCode) {
    url.searchParams.set("language_code", config.languageCode);
  }
  if (config.vadSilenceThresholdSecs != null) {
    url.searchParams.set("vad_silence_threshold_secs", String(config.vadSilenceThresholdSecs));
  }
  if (config.vadThreshold != null) {
    url.searchParams.set("vad_threshold", String(config.vadThreshold));
  }
  if (config.minSpeechDurationMs != null) {
    url.searchParams.set("min_speech_duration_ms", String(config.minSpeechDurationMs));
  }
  if (config.minSilenceDurationMs != null) {
    url.searchParams.set("min_silence_duration_ms", String(config.minSilenceDurationMs));
  }
  return url.toString();
}

function createElevenLabsUtteranceSession(
  req: RealtimeTranscriptionSessionCreateRequest,
  config: ReturnType<typeof normalizeProviderConfig>,
  apiKey: string,
  createWebSocketSession: PluginCapabilityCatalogContext["createRealtimeTranscriptionWebSocketSession"],
): RealtimeTranscriptionSession {
  const utterance = req.utterance;
  if (
    !utterance ||
    utterance.format.encoding !== "pcm_s16le" ||
    utterance.format.sampleRate !== 16000 ||
    utterance.format.channels !== 1
  ) {
    throw new Error("ElevenLabs finite transcription requires mono PCM16 at 16000 Hz");
  }
  if (config.modelId && config.modelId !== ELEVENLABS_REALTIME_DEFAULT_MODEL) {
    throw new Error(`ElevenLabs finite transcription does not support model ${config.modelId}`);
  }
  const finiteConfig = {
    ...config,
    audioFormat: "pcm_16000",
    sampleRate: 16000,
    commitStrategy: "manual" as const,
  };
  return createFiniteRealtimeTranscriptionSession({
    callbacks: req,
    signal: utterance.signal,
    // Serialize acknowledgments well below Scribe's ~36-second automatic commit.
    // Each acknowledged segment covers its complete byte interval, even on long input.
    segmentBytes: 16000 * 2 * 8,
    frameBytes: 16000 * 2,
    alignmentBytes: 2,
    createSession: (callbacks) => {
      let transport: RealtimeTranscriptionWebSocketTransport | undefined;
      let started = false;
      const session = createWebSocketSession<ElevenLabsRealtimeTranscriptionEvent>({
        providerId: "elevenlabs",
        callbacks,
        lifecycle: "utterance",
        url: () => toElevenLabsRealtimeWsUrl(finiteConfig),
        headers: { "xi-api-key": apiKey },
        sendAudio: (audio, currentTransport) => {
          if (
            !currentTransport.sendJson({
              message_type: "input_audio_chunk",
              audio_base_64: audio.toString("base64"),
              sample_rate: 16000,
              commit: false,
            })
          ) {
            throw new Error("ElevenLabs finite transcription could not send audio");
          }
        },
        onMessage: (event, currentTransport) => {
          if (event.message_type === "session_started") {
            transport = currentTransport;
            started = true;
            currentTransport.markReady();
            return;
          }
          if (typeof event.error === "string" || event.message_type?.includes("error")) {
            const error = new Error(readErrorDetail(event));
            if (!started) {
              currentTransport.failConnect(error);
            } else {
              callbacks.onError?.(error);
            }
            return;
          }
          if (event.message_type === "partial_transcript" && typeof event.text === "string") {
            callbacks.onPartial?.(event.text);
          } else if (event.message_type === "committed_transcript") {
            if (typeof event.text !== "string") {
              callbacks.onError?.(new Error("ElevenLabs committed transcript is missing text"));
              return;
            }
            callbacks.onTranscript?.(event.text);
          }
        },
      });
      return {
        session,
        commit: () => {
          if (
            !transport?.sendJson({
              message_type: "input_audio_chunk",
              audio_base_64: "",
              sample_rate: 16000,
              commit: true,
            })
          ) {
            throw new Error("ElevenLabs finite transcription could not commit input");
          }
        },
      };
    },
  });
}

function resolveElevenLabsRealtimeApiKey(
  config: ReturnType<typeof normalizeProviderConfig>,
): string | null | undefined {
  return (
    config.apiKey ??
    resolveElevenLabsApiKeyWithProfileFallback() ??
    normalizeOptionalString(process.env.XI_API_KEY)
  );
}

export function buildElevenLabsRealtimeTranscriptionProvider({
  createRealtimeTranscriptionWebSocketSession,
}: Pick<
  PluginCapabilityCatalogContext,
  "createRealtimeTranscriptionWebSocketSession"
>): RealtimeTranscriptionProviderPlugin {
  const isConfigured: NonNullable<RealtimeTranscriptionProviderPlugin["isConfigured"]> = ({
    providerConfig,
  }) => Boolean(resolveElevenLabsRealtimeApiKey(normalizeProviderConfig(providerConfig)));
  return {
    id: "elevenlabs",
    label: "ElevenLabs Realtime Transcription",
    aliases: ["elevenlabs-realtime", "scribe-v2-realtime"],
    defaultModel: ELEVENLABS_REALTIME_DEFAULT_MODEL,
    autoSelectOrder: 40,
    utterance: {
      formats: [{ encoding: "pcm_s16le", sampleRate: 16000, channels: 1 }],
      models: [ELEVENLABS_REALTIME_DEFAULT_MODEL],
    },
    resolveConfig: ({ rawConfig }) => normalizeProviderConfig(rawConfig),
    // Retained for synchronous SDK consumers through 2026-12-31.
    isConfigured,
    isConfiguredAsync: async (ctx) => isConfigured(ctx),
    createSession: (req) => {
      const config = normalizeProviderConfig(req.providerConfig);
      const apiKey = resolveElevenLabsRealtimeApiKey(config);
      if (!apiKey) {
        throw new Error("ElevenLabs API key missing");
      }
      if (req.utterance) {
        return createElevenLabsUtteranceSession(
          req,
          config,
          apiKey,
          createRealtimeTranscriptionWebSocketSession,
        );
      }
      const sampleRate = config.sampleRate ?? ELEVENLABS_REALTIME_DEFAULT_SAMPLE_RATE;
      const commitStrategy = config.commitStrategy ?? ELEVENLABS_REALTIME_DEFAULT_COMMIT_STRATEGY;
      let pendingTimestampEcho: string | undefined;

      return createRealtimeTranscriptionWebSocketSession<ElevenLabsRealtimeTranscriptionEvent>({
        providerId: "elevenlabs",
        callbacks: req,
        url: () => toElevenLabsRealtimeWsUrl(config),
        headers: { "xi-api-key": apiKey },
        connectTimeoutMessage: "ElevenLabs realtime transcription connection timeout",
        reconnectLimitMessage: "ElevenLabs realtime transcription reconnect limit reached",
        sendAudio: (audio, transport) => {
          transport.sendJson({
            message_type: "input_audio_chunk",
            audio_base_64: audio.toString("base64"),
            sample_rate: sampleRate,
            ...(commitStrategy === "manual" ? { commit: true } : {}),
          });
        },
        onClose: (transport) => {
          transport.sendJson({
            message_type: "input_audio_chunk",
            audio_base_64: "",
            sample_rate: sampleRate,
            commit: true,
          });
        },
        onMessage: (event, transport) => {
          if (event.message_type === "session_started") {
            pendingTimestampEcho = undefined;
            transport.markReady();
            return;
          }
          const isError = typeof event.error === "string" || event.message_type?.includes("error");
          if (!transport.isReady() && isError) {
            transport.failConnect(new Error(readErrorDetail(event)));
            return;
          }
          switch (event.message_type) {
            case "partial_transcript":
              if (event.text) {
                req.onPartial?.(event.text);
              }
              return;
            case "committed_transcript":
            case "committed_transcript_with_timestamps":
              if (event.text) {
                // A committed segment can have one matching timestamp companion, never another turn.
                const hasTimestamps = event.message_type !== "committed_transcript";
                const isEcho = hasTimestamps && pendingTimestampEcho === event.text;
                pendingTimestampEcho = hasTimestamps ? undefined : event.text;
                if (!isEcho) {
                  req.onTranscript?.(event.text);
                }
              }
              return;
            default:
              if (isError) {
                req.onError?.(new Error(readErrorDetail(event)));
              }
          }
        },
      });
    },
  };
}
