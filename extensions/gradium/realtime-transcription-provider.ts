import {
  createRealtimeTranscriptionWebSocketSession,
  type RealtimeTranscriptionProviderConfig,
  type RealtimeTranscriptionProviderPlugin,
  type RealtimeTranscriptionSession,
  type RealtimeTranscriptionSessionCreateRequest,
  type RealtimeTranscriptionWebSocketTransport,
} from "openclaw/plugin-sdk/realtime-transcription";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { DEFAULT_GRADIUM_BASE_URL, normalizeGradiumBaseUrl } from "./shared.js";

type GradiumRealtimeInputFormat = "pcm" | "wav" | "opus" | "ulaw_8000" | "alaw_8000";

type GradiumRealtimeProviderConfig = {
  apiKey?: string;
  baseUrl?: string;
  modelName?: string;
  inputFormat?: GradiumRealtimeInputFormat;
  language?: string;
};

type GradiumRealtimeSessionConfig = RealtimeTranscriptionSessionCreateRequest & {
  apiKey: string;
  baseUrl: string;
  modelName: string;
  inputFormat: GradiumRealtimeInputFormat;
  language?: string;
};

type GradiumRealtimeEvent = {
  type?: string;
  text?: string;
  message?: string;
  error?: string;
};

const GRADIUM_REALTIME_DEFAULT_MODEL = "default";
const GRADIUM_REALTIME_DEFAULT_INPUT_FORMAT: GradiumRealtimeInputFormat = "ulaw_8000";
const GRADIUM_REALTIME_CONNECT_TIMEOUT_MS = 10_000;
const GRADIUM_REALTIME_CLOSE_TIMEOUT_MS = 5_000;
const GRADIUM_REALTIME_MAX_RECONNECT_ATTEMPTS = 5;
const GRADIUM_REALTIME_RECONNECT_DELAY_MS = 1000;
const GRADIUM_REALTIME_MAX_QUEUED_BYTES = 2 * 1024 * 1024;

const VALID_INPUT_FORMATS: ReadonlySet<GradiumRealtimeInputFormat> = new Set([
  "pcm",
  "wav",
  "opus",
  "ulaw_8000",
  "alaw_8000",
]);

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readNestedGradiumConfig(rawConfig: RealtimeTranscriptionProviderConfig) {
  const raw = readRecord(rawConfig);
  const providers = readRecord(raw?.providers);
  return readRecord(providers?.gradium ?? raw?.gradium ?? raw) ?? {};
}

function normalizeInputFormat(value: unknown): GradiumRealtimeInputFormat | undefined {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (VALID_INPUT_FORMATS.has(normalized as GradiumRealtimeInputFormat)) {
    return normalized as GradiumRealtimeInputFormat;
  }
  throw new Error(`Invalid Gradium realtime transcription input format: ${normalized}`);
}

function normalizeProviderConfig(
  config: RealtimeTranscriptionProviderConfig,
): GradiumRealtimeProviderConfig {
  const raw = readNestedGradiumConfig(config);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw.apiKey,
      path: "plugins.entries.voice-call.config.streaming.providers.gradium.apiKey",
    }),
    baseUrl: normalizeOptionalString(raw.baseUrl),
    modelName: normalizeOptionalString(raw.modelName ?? raw.model_name ?? raw.model),
    inputFormat: normalizeInputFormat(raw.inputFormat ?? raw.input_format ?? raw.encoding),
    language: normalizeOptionalString(raw.language),
  };
}

function normalizeGradiumRealtimeBaseUrl(value?: string): string {
  return normalizeGradiumBaseUrl(value ?? process.env.GRADIUM_BASE_URL);
}

function toGradiumRealtimeWsUrl(config: GradiumRealtimeSessionConfig): string {
  const url = new URL(`${normalizeGradiumRealtimeBaseUrl(config.baseUrl)}/api/speech/asr`);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  return url.toString();
}

function readErrorDetail(event: GradiumRealtimeEvent): string {
  return (
    normalizeOptionalString(event.message) ??
    normalizeOptionalString(event.error) ??
    "Gradium realtime transcription error"
  );
}

function buildSetupPayload(config: GradiumRealtimeSessionConfig) {
  const payload: Record<string, unknown> = {
    type: "setup",
    model_name: config.modelName,
    input_format: config.inputFormat,
  };
  if (config.language) {
    payload.json_config = { language: config.language };
  }
  return payload;
}

function createGradiumRealtimeTranscriptionSession(
  config: GradiumRealtimeSessionConfig,
): RealtimeTranscriptionSession {
  let speechStarted = false;

  const sendAudioChunk = (
    audio: Buffer,
    transport: RealtimeTranscriptionWebSocketTransport,
  ): void => {
    transport.sendJson({ type: "audio", audio: audio.toString("base64") });
  };

  const handleEvent = (
    event: GradiumRealtimeEvent,
    transport: RealtimeTranscriptionWebSocketTransport,
  ) => {
    switch (event.type) {
      case "ready":
        transport.markReady();
        return;
      case "text": {
        const text = normalizeOptionalString(event.text);
        if (!text) {
          return;
        }
        if (!speechStarted) {
          speechStarted = true;
          config.onSpeechStart?.();
        }
        config.onTranscript?.(text);
        return;
      }
      case "error":
        if (!transport.isReady()) {
          transport.failConnect(new Error(readErrorDetail(event)));
          return;
        }
        config.onError?.(new Error(readErrorDetail(event)));
        return;
      default:
        return;
    }
  };

  return createRealtimeTranscriptionWebSocketSession<GradiumRealtimeEvent>({
    providerId: "gradium",
    callbacks: config,
    url: () => toGradiumRealtimeWsUrl(config),
    headers: { "x-api-key": config.apiKey },
    connectTimeoutMs: GRADIUM_REALTIME_CONNECT_TIMEOUT_MS,
    closeTimeoutMs: GRADIUM_REALTIME_CLOSE_TIMEOUT_MS,
    maxReconnectAttempts: GRADIUM_REALTIME_MAX_RECONNECT_ATTEMPTS,
    reconnectDelayMs: GRADIUM_REALTIME_RECONNECT_DELAY_MS,
    maxQueuedBytes: GRADIUM_REALTIME_MAX_QUEUED_BYTES,
    connectTimeoutMessage: "Gradium realtime transcription connection timeout",
    reconnectLimitMessage: "Gradium realtime transcription reconnect limit reached",
    sendAudio: sendAudioChunk,
    onOpen: (transport) => {
      transport.sendJson(buildSetupPayload(config));
    },
    onClose: (transport) => {
      transport.sendJson({ type: "end_of_stream" });
    },
    onMessage: handleEvent,
  });
}

export function buildGradiumRealtimeTranscriptionProvider(): RealtimeTranscriptionProviderPlugin {
  return {
    id: "gradium",
    label: "Gradium Realtime Transcription",
    aliases: ["gradium-realtime", "gradium-asr"],
    autoSelectOrder: 50,
    resolveConfig: ({ rawConfig }) => normalizeProviderConfig(rawConfig),
    isConfigured: ({ providerConfig }) =>
      Boolean(normalizeProviderConfig(providerConfig).apiKey || process.env.GRADIUM_API_KEY),
    createSession: (req) => {
      const config = normalizeProviderConfig(req.providerConfig);
      const apiKey = config.apiKey || process.env.GRADIUM_API_KEY;
      if (!apiKey) {
        throw new Error("Gradium API key missing");
      }
      return createGradiumRealtimeTranscriptionSession({
        ...req,
        apiKey,
        baseUrl: normalizeGradiumRealtimeBaseUrl(config.baseUrl) || DEFAULT_GRADIUM_BASE_URL,
        modelName: config.modelName ?? GRADIUM_REALTIME_DEFAULT_MODEL,
        inputFormat: config.inputFormat ?? GRADIUM_REALTIME_DEFAULT_INPUT_FORMAT,
        language: config.language,
      });
    },
  };
}

export const __testing = {
  normalizeProviderConfig,
  toGradiumRealtimeWsUrl,
  buildSetupPayload,
};
