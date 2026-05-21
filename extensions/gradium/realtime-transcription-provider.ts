import {
  createRealtimeTranscriptionWebSocketSession,
  type RealtimeTranscriptionProviderConfig,
  type RealtimeTranscriptionProviderPlugin,
  type RealtimeTranscriptionSession,
  type RealtimeTranscriptionSessionCreateRequest,
  type RealtimeTranscriptionWebSocketTransport,
} from "openclaw/plugin-sdk/realtime-transcription";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { DEFAULT_GRADIUM_BASE_URL, normalizeGradiumBaseUrl } from "./shared.js";

type GradiumRealtimeInputFormat = "pcm" | "wav" | "opus" | "ulaw_8000" | "alaw_8000";

type GradiumRealtimeProviderConfig = {
  apiKey?: string;
  baseUrl?: string;
  modelName?: string;
  inputFormat?: GradiumRealtimeInputFormat;
  language?: string;
  temp?: number;
  paddingBonus?: number;
  delayInFrames?: number;
  semanticVad?: boolean;
  semanticVadThreshold?: number;
  semanticVadHorizonIndex?: number;
};

type GradiumRealtimeSessionConfig = RealtimeTranscriptionSessionCreateRequest & {
  apiKey: string;
  baseUrl: string;
  modelName: string;
  inputFormat: GradiumRealtimeInputFormat;
  language?: string;
  temp?: number;
  paddingBonus?: number;
  delayInFrames?: number;
  semanticVad: boolean;
  semanticVadThreshold: number;
  semanticVadHorizonIndex: number;
};

type GradiumRealtimeConnectionConfig = {
  baseUrl: string;
};

type GradiumRealtimeSetupConfig = {
  modelName: string;
  inputFormat: GradiumRealtimeInputFormat;
  language?: string;
  temp?: number;
  paddingBonus?: number;
  delayInFrames?: number;
};

type GradiumRealtimeEvent = {
  type?: string;
  text?: string;
  vad?: Array<number | { inactivity_prob?: number; inactivityProb?: number }>;
  message?: string;
  error?: string;
};

const GRADIUM_REALTIME_DEFAULT_MODEL = "default";
const GRADIUM_REALTIME_DEFAULT_INPUT_FORMAT: GradiumRealtimeInputFormat = "ulaw_8000";
const GRADIUM_REALTIME_DEFAULT_SEMANTIC_VAD = true;
const GRADIUM_REALTIME_DEFAULT_SEMANTIC_VAD_THRESHOLD = 0.5;
const GRADIUM_REALTIME_DEFAULT_SEMANTIC_VAD_HORIZON_INDEX = 2;
const GRADIUM_REALTIME_SEMANTIC_FALLBACK_FLUSH_MS = 900;
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
const VALID_DELAY_IN_FRAMES: ReadonlySet<number> = new Set([
  7, 8, 10, 12, 14, 16, 20, 24, 32, 36, 48,
]);

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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

function readNonNegativeInteger(value: unknown): number | undefined {
  const next = readFiniteNumber(value);
  if (next == null || next < 0) {
    return undefined;
  }
  return Math.floor(next);
}

function normalizeDelayInFrames(value: unknown): number | undefined {
  const delayInFrames = readNonNegativeInteger(value);
  if (delayInFrames == null) {
    return undefined;
  }
  if (VALID_DELAY_IN_FRAMES.has(delayInFrames)) {
    return delayInFrames;
  }
  throw new Error(
    `Invalid Gradium realtime transcription delayInFrames: ${delayInFrames}. Expected one of ${[
      ...VALID_DELAY_IN_FRAMES,
    ].join(", ")}`,
  );
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
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
    temp: readFiniteNumber(raw.temp),
    paddingBonus: readFiniteNumber(raw.paddingBonus ?? raw.padding_bonus),
    delayInFrames: normalizeDelayInFrames(raw.delayInFrames ?? raw.delay_in_frames),
    semanticVad: readBoolean(raw.semanticVad ?? raw.semantic_vad),
    semanticVadThreshold: readFiniteNumber(
      raw.semanticVadThreshold ?? raw.semantic_vad_threshold ?? raw.vadThreshold,
    ),
    semanticVadHorizonIndex: readNonNegativeInteger(
      raw.semanticVadHorizonIndex ?? raw.semantic_vad_horizon_index,
    ),
  };
}

function normalizeGradiumRealtimeBaseUrl(value?: string): string {
  return normalizeGradiumBaseUrl(value ?? process.env.GRADIUM_BASE_URL);
}

function toGradiumRealtimeWsUrl(config: GradiumRealtimeConnectionConfig): string {
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

function buildSetupPayload(config: GradiumRealtimeSetupConfig) {
  const payload: Record<string, unknown> = {
    type: "setup",
    model_name: config.modelName,
    input_format: config.inputFormat,
  };
  const jsonConfig: Record<string, unknown> = {};
  if (config.language) {
    jsonConfig.language = config.language;
  }
  if (config.temp != null) {
    jsonConfig.temp = config.temp;
  }
  if (config.paddingBonus != null) {
    jsonConfig.padding_bonus = config.paddingBonus;
  }
  if (config.delayInFrames != null) {
    jsonConfig.delay_in_frames = config.delayInFrames;
  }
  if (Object.keys(jsonConfig).length > 0) {
    payload.json_config = JSON.stringify(jsonConfig);
  }
  return payload;
}

function joinTranscriptSegments(segments: string[]): string | undefined {
  return normalizeOptionalString(segments.join(""));
}

function readTranscriptChunk(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  return value;
}

function shouldFlushForSemanticVad(
  event: GradiumRealtimeEvent,
  config: GradiumRealtimeSessionConfig,
): boolean {
  if (!config.semanticVad || !event.vad) {
    return false;
  }
  const prediction = event.vad[config.semanticVadHorizonIndex];
  const probability =
    typeof prediction === "number"
      ? prediction
      : (prediction?.inactivity_prob ?? prediction?.inactivityProb);
  return typeof probability === "number" && probability >= config.semanticVadThreshold;
}

function createGradiumRealtimeEventHandler(config: GradiumRealtimeSessionConfig) {
  let nextFlushId = 1;
  let speechStarted = false;
  let flushRequested = false;
  let fallbackFlushTimer: ReturnType<typeof setTimeout> | undefined;
  let lastPartial: string | undefined;
  let transcriptSegments: string[] = [];

  const clearFallbackFlushTimer = () => {
    if (!fallbackFlushTimer) {
      return;
    }
    clearTimeout(fallbackFlushTimer);
    fallbackFlushTimer = undefined;
  };

  const emitPartial = () => {
    const partial = joinTranscriptSegments(transcriptSegments);
    if (!partial || partial === lastPartial) {
      return;
    }
    lastPartial = partial;
    config.onPartial?.(partial);
  };

  const appendTranscript = (text: string) => {
    clearFallbackFlushTimer();
    if (!speechStarted) {
      speechStarted = true;
      config.onSpeechStart?.();
    }
    transcriptSegments.push(text);
    emitPartial();
  };

  const commitTranscript = () => {
    clearFallbackFlushTimer();
    const transcript = joinTranscriptSegments(transcriptSegments);
    if (!transcript) {
      flushRequested = false;
      return;
    }
    config.onTranscript?.(transcript);
    transcriptSegments = [];
    lastPartial = undefined;
    speechStarted = false;
    flushRequested = false;
  };

  const requestFlush = (transport: RealtimeTranscriptionWebSocketTransport) => {
    if (flushRequested || transcriptSegments.length === 0) {
      return;
    }
    clearFallbackFlushTimer();
    flushRequested = true;
    transport.sendJson({ type: "flush", flush_id: nextFlushId++ });
  };

  const scheduleFallbackFlush = (transport: RealtimeTranscriptionWebSocketTransport) => {
    if (fallbackFlushTimer || flushRequested || transcriptSegments.length === 0) {
      return;
    }
    fallbackFlushTimer = setTimeout(() => {
      fallbackFlushTimer = undefined;
      requestFlush(transport);
    }, GRADIUM_REALTIME_SEMANTIC_FALLBACK_FLUSH_MS);
    fallbackFlushTimer.unref?.();
  };

  return (event: GradiumRealtimeEvent, transport: RealtimeTranscriptionWebSocketTransport) => {
    switch (event.type) {
      case "ready":
        commitTranscript();
        transport.markReady();
        return;
      case "text": {
        const text = readTranscriptChunk(event.text);
        if (!text) {
          return;
        }
        appendTranscript(text);
        return;
      }
      case "flushed":
      case "done":
      case "end_of_stream":
        commitTranscript();
        return;
      case "end_text":
        if (flushRequested) {
          commitTranscript();
          return;
        }
        if (config.semanticVad) {
          scheduleFallbackFlush(transport);
          return;
        }
        if (!flushRequested) {
          commitTranscript();
        }
        return;
      case "step": {
        if (
          transcriptSegments.length > 0 &&
          !flushRequested &&
          shouldFlushForSemanticVad(event, config)
        ) {
          requestFlush(transport);
        }
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
}

function createGradiumRealtimeTranscriptionSession(
  config: GradiumRealtimeSessionConfig,
): RealtimeTranscriptionSession {
  const handleEvent = createGradiumRealtimeEventHandler(config);
  const sendAudioChunk = (
    audio: Buffer,
    transport: RealtimeTranscriptionWebSocketTransport,
  ): void => {
    transport.sendJson({ type: "audio", audio: audio.toString("base64") });
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
      handleEvent({ type: "end_of_stream" }, transport);
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
        temp: config.temp,
        paddingBonus: config.paddingBonus,
        delayInFrames: config.delayInFrames,
        semanticVad: config.semanticVad ?? GRADIUM_REALTIME_DEFAULT_SEMANTIC_VAD,
        semanticVadThreshold:
          config.semanticVadThreshold ?? GRADIUM_REALTIME_DEFAULT_SEMANTIC_VAD_THRESHOLD,
        semanticVadHorizonIndex:
          config.semanticVadHorizonIndex ?? GRADIUM_REALTIME_DEFAULT_SEMANTIC_VAD_HORIZON_INDEX,
      });
    },
  };
}

export const testing = {
  normalizeProviderConfig,
  toGradiumRealtimeWsUrl,
  buildSetupPayload,
  createGradiumRealtimeEventHandler,
};
export { testing as __testing };
