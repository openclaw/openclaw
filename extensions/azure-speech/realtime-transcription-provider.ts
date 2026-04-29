import {
  type RealtimeTranscriptionProviderConfig,
  type RealtimeTranscriptionProviderPlugin,
} from "openclaw/plugin-sdk/realtime-transcription";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import {
  AZURE_SPEECH_REALTIME_MAX_QUEUED_BYTES,
  audioFormatTagFor,
  bitsPerSampleFor,
  bufferToArrayBuffer,
  createAzureSpeechRealtimeTranscriptionSession,
  type AzureSpeechRealtimeDeps,
  type AzureSpeechRealtimeEncoding,
} from "./realtime-transcription-session.js";
import type {
  AzureSpeechCancellationEvent,
  AzureSpeechPushStream,
  AzureSpeechRealtimeSdk,
  AzureSpeechRecognitionEvent,
  AzureSpeechSpeechConfig,
  AzureSpeechSpeechRecognizer,
} from "./realtime-transcription-types.js";

// Re-export the SDK shape and event types so tests and consumers can reference
// them via this module's public surface.
export type {
  AzureSpeechCancellationEvent,
  AzureSpeechPushStream,
  AzureSpeechRealtimeSdk,
  AzureSpeechRecognitionEvent,
  AzureSpeechSpeechConfig,
  AzureSpeechSpeechRecognizer,
};
export { createAzureSpeechRealtimeTranscriptionSession };

type AzureSpeechRealtimeProviderConfig = {
  apiKey?: string;
  region?: string;
  endpoint?: string;
  language?: string;
  sampleRate?: number;
  encoding?: AzureSpeechRealtimeEncoding;
  initialSilenceTimeoutMs?: number;
  endSilenceTimeoutMs?: number;
  /** Optional list of additional languages for auto language ID. */
  candidateLanguages?: string[];
};

const AZURE_SPEECH_REALTIME_DEFAULT_LANGUAGE = "en-US";
const AZURE_SPEECH_REALTIME_DEFAULT_SAMPLE_RATE = 8000;
const AZURE_SPEECH_REALTIME_DEFAULT_ENCODING: AzureSpeechRealtimeEncoding = "mulaw";
const AZURE_SPEECH_REALTIME_DEFAULT_INITIAL_SILENCE_MS = 5000;
const AZURE_SPEECH_REALTIME_DEFAULT_END_SILENCE_MS = 800;

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readNestedAzureSpeechConfig(rawConfig: RealtimeTranscriptionProviderConfig) {
  const raw = readRecord(rawConfig);
  const providers = readRecord(raw?.providers);
  return (
    readRecord(providers?.["azure-speech"]) ??
    readRecord(providers?.azure) ??
    readRecord(raw?.["azure-speech"]) ??
    readRecord(raw?.azure) ??
    raw ??
    {}
  );
}

function readFiniteNumber(value: unknown): number | undefined {
  const next =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : undefined;
  return Number.isFinite(next) ? next : undefined;
}

function readStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const out = value
      .map((entry) => normalizeOptionalString(entry))
      .filter((entry): entry is string => Boolean(entry));
    return out.length > 0 ? out : undefined;
  }
  const single = normalizeOptionalString(value);
  if (!single) {
    return undefined;
  }
  const parts = single
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts : undefined;
}

function normalizeAzureSpeechRealtimeEncoding(
  value: unknown,
): AzureSpeechRealtimeEncoding | undefined {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (
    normalized === "pcm" ||
    normalized === "linear16" ||
    normalized === "pcm_s16le" ||
    normalized === "wav"
  ) {
    return "pcm";
  }
  if (
    normalized === "mulaw" ||
    normalized === "ulaw" ||
    normalized === "g711_ulaw" ||
    normalized === "g711-mulaw"
  ) {
    return "mulaw";
  }
  if (normalized === "alaw" || normalized === "g711_alaw" || normalized === "g711-alaw") {
    return "alaw";
  }
  throw new Error(`Invalid Azure Speech realtime transcription encoding: ${normalized}`);
}

export function readAzureSpeechRealtimeApiKey(
  raw: Record<string, unknown> | undefined,
): string | undefined {
  return (
    normalizeResolvedSecretInputString({
      value: raw?.apiKey,
      path: "plugins.entries.voice-call.config.streaming.providers.azure-speech.apiKey",
    }) ??
    normalizeOptionalString(process.env.AZURE_SPEECH_KEY) ??
    normalizeOptionalString(process.env.AZURE_SPEECH_API_KEY) ??
    normalizeOptionalString(process.env.SPEECH_KEY)
  );
}

export function readAzureSpeechRealtimeRegion(
  raw: Record<string, unknown> | undefined,
): string | undefined {
  return (
    normalizeOptionalString(raw?.region) ??
    normalizeOptionalString(process.env.AZURE_SPEECH_REGION) ??
    normalizeOptionalString(process.env.SPEECH_REGION)
  );
}

export function readAzureSpeechRealtimeEndpoint(
  raw: Record<string, unknown> | undefined,
): string | undefined {
  return (
    normalizeOptionalString(raw?.endpoint) ??
    normalizeOptionalString(process.env.AZURE_SPEECH_ENDPOINT)
  );
}

export function normalizeAzureSpeechRealtimeProviderConfig(
  config: RealtimeTranscriptionProviderConfig,
): AzureSpeechRealtimeProviderConfig {
  const raw = readNestedAzureSpeechConfig(config);
  return {
    apiKey: readAzureSpeechRealtimeApiKey(raw),
    region: readAzureSpeechRealtimeRegion(raw),
    endpoint: readAzureSpeechRealtimeEndpoint(raw),
    language: normalizeOptionalString(raw?.language ?? raw?.lang),
    sampleRate: readFiniteNumber(raw?.sampleRate ?? raw?.sample_rate),
    encoding: normalizeAzureSpeechRealtimeEncoding(raw?.encoding),
    initialSilenceTimeoutMs: readFiniteNumber(
      raw?.initialSilenceTimeoutMs ?? raw?.initialSilenceMs ?? raw?.initial_silence_ms,
    ),
    endSilenceTimeoutMs: readFiniteNumber(
      raw?.endSilenceTimeoutMs ??
        raw?.endSilenceMs ??
        raw?.endpointingMs ??
        raw?.silenceDurationMs ??
        raw?.endpointing,
    ),
    candidateLanguages: readStringList(raw?.candidateLanguages ?? raw?.languages),
  };
}

async function loadAzureSpeechSdk(): Promise<AzureSpeechRealtimeSdk> {
  const mod = (await import("microsoft-cognitiveservices-speech-sdk")) as unknown as Record<
    string,
    unknown
  >;
  const sdk = (mod.default ?? mod) as AzureSpeechRealtimeSdk;
  if (!sdk?.SpeechConfig?.fromSubscription || !sdk?.AudioInputStream?.createPushStream) {
    throw new Error(
      "microsoft-cognitiveservices-speech-sdk is missing expected exports; reinstall the package",
    );
  }
  return sdk;
}

const defaultDeps: AzureSpeechRealtimeDeps = {
  loadSdk: loadAzureSpeechSdk,
};

export function buildAzureSpeechRealtimeTranscriptionProvider(
  deps: AzureSpeechRealtimeDeps = defaultDeps,
): RealtimeTranscriptionProviderPlugin {
  return {
    id: "azure-speech",
    label: "Azure Speech Realtime Transcription",
    aliases: ["azure", "azure-realtime", "azure-speech-realtime"],
    autoSelectOrder: 30,
    resolveConfig: ({ rawConfig }) => normalizeAzureSpeechRealtimeProviderConfig(rawConfig),
    isConfigured: ({ providerConfig }) => {
      // providerConfig is already the normalized output of resolveConfig, so use
      // its typed fields directly instead of re-normalizing.
      const cfg = providerConfig as AzureSpeechRealtimeProviderConfig;
      if (!cfg.apiKey) {
        return false;
      }
      return Boolean(cfg.endpoint || cfg.region);
    },
    createSession: (req) => {
      const normalized = normalizeAzureSpeechRealtimeProviderConfig(req.providerConfig);
      if (!normalized.apiKey) {
        throw new Error(
          "Azure Speech API key missing (set apiKey, AZURE_SPEECH_KEY, AZURE_SPEECH_API_KEY, or SPEECH_KEY)",
        );
      }
      if (!normalized.endpoint && !normalized.region) {
        throw new Error(
          "Azure Speech requires region or endpoint (set region/endpoint, AZURE_SPEECH_REGION, SPEECH_REGION, or AZURE_SPEECH_ENDPOINT)",
        );
      }
      return createAzureSpeechRealtimeTranscriptionSession(
        {
          ...req,
          apiKey: normalized.apiKey,
          region: normalized.region,
          endpoint: normalized.endpoint,
          language: normalized.language ?? AZURE_SPEECH_REALTIME_DEFAULT_LANGUAGE,
          sampleRate: normalized.sampleRate ?? AZURE_SPEECH_REALTIME_DEFAULT_SAMPLE_RATE,
          encoding: normalized.encoding ?? AZURE_SPEECH_REALTIME_DEFAULT_ENCODING,
          initialSilenceTimeoutMs:
            normalized.initialSilenceTimeoutMs ?? AZURE_SPEECH_REALTIME_DEFAULT_INITIAL_SILENCE_MS,
          endSilenceTimeoutMs:
            normalized.endSilenceTimeoutMs ?? AZURE_SPEECH_REALTIME_DEFAULT_END_SILENCE_MS,
          candidateLanguages: normalized.candidateLanguages,
        },
        deps,
      );
    },
  };
}

export const __testing = {
  normalizeAzureSpeechRealtimeProviderConfig,
  audioFormatTagFor,
  bitsPerSampleFor,
  bufferToArrayBuffer,
  AZURE_SPEECH_REALTIME_DEFAULTS: {
    LANGUAGE: AZURE_SPEECH_REALTIME_DEFAULT_LANGUAGE,
    SAMPLE_RATE: AZURE_SPEECH_REALTIME_DEFAULT_SAMPLE_RATE,
    ENCODING: AZURE_SPEECH_REALTIME_DEFAULT_ENCODING,
    INITIAL_SILENCE_MS: AZURE_SPEECH_REALTIME_DEFAULT_INITIAL_SILENCE_MS,
    END_SILENCE_MS: AZURE_SPEECH_REALTIME_DEFAULT_END_SILENCE_MS,
    MAX_QUEUED_BYTES: AZURE_SPEECH_REALTIME_MAX_QUEUED_BYTES,
  },
};
