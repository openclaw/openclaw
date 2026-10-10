import type {
  OpenAICompatibleRealtimeAudioFormat,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceProviderConfig,
} from "openclaw/plugin-sdk/realtime-voice";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import {
  asFiniteNumberInRange,
  asOptionalObjectRecord as readInworldObjectRecord,
  asSafeIntegerInRange,
  normalizeOptionalString,
  parseBooleanValue,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeInworldBaseUrl } from "./tts.js";

export type InworldRealtimeTurnDetectionMode = "semantic_vad" | "server_vad";
export type InworldRealtimeEagerness = "low" | "medium" | "high";
export type InworldRealtimeDeliveryMode = "STABLE" | "BALANCED" | "CREATIVE";
export type InworldRealtimeSteeringHandling = "repeat_each_chunk" | "emit_once";
export type InworldRealtimeSegmenterStrategy =
  | "auto"
  | "balanced"
  | "sentence"
  | "full_turn"
  | "fast_start"
  | "per_segment_context";

/**
 * Documented Inworld `providerData` sections operators may pass through
 * (docs.inworld.ai/realtime/provider-data). `backchannel` is deliberately absent: Inworld
 * delivers interjections as out-of-band `response.backchannel.audio.delta` events, and the
 * host playback contract (Talk relay output ownership, Voice Call truncation of every
 * snapshot item) has no out-of-band channel yet, so the adapter never enables it.
 */
export const INWORLD_REALTIME_PROVIDER_DATA_SECTIONS = [
  "stt",
  "tts",
  "memory",
  "responsiveness",
] as const;
export type InworldRealtimeProviderDataSection =
  (typeof INWORLD_REALTIME_PROVIDER_DATA_SECTIONS)[number];
export type InworldRealtimeProviderDataPassthrough = Partial<
  Record<InworldRealtimeProviderDataSection, Record<string, unknown>>
>;
/** Upper bound for the serialized passthrough so a config typo cannot balloon session.update. */
export const INWORLD_REALTIME_PROVIDER_DATA_MAX_BYTES = 8 * 1024;

type InworldRealtimeVoiceProviderConfig = Partial<
  ReturnType<typeof normalizeInworldRealtimeProviderConfig>
>;

export type InworldRealtimeVoiceBridgeConfig = RealtimeVoiceBridgeCreateRequest &
  Omit<InworldRealtimeVoiceProviderConfig, "interruptResponseOnInputAudio"> & {
    baseUrl: string;
    resolveApiKey?: () => Promise<string>;
  };

type InworldRealtimeResponseItem = {
  id?: string;
  type?: string;
  status?: "completed" | "incomplete" | "in_progress";
  role?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: Array<{ type?: string; text?: string; transcript?: string }>;
};

export type InworldRealtimeEvent = {
  type: string;
  delta?: string;
  data?: string;
  text?: string;
  transcript?: string;
  item_id?: string;
  response_id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  response?: {
    id?: string;
    status?: string;
    status_details?: unknown;
    output?: InworldRealtimeResponseItem[];
  };
  conversation?: { id?: string };
  item?: InworldRealtimeResponseItem;
  error?: unknown;
  session?: {
    audio?: { output?: { format?: unknown } };
    output_audio_format?: unknown;
  };
  /** Inworld back-channel interjections (`response.backchannel.*`) group deltas by this id. */
  backchannel_id?: string;
  phrase?: string;
  reason?: string;
};

export type InworldRealtimeSessionUpdate = {
  type: "session.update";
  session: {
    type: "realtime";
    model?: string;
    instructions?: string;
    output_modalities: string[];
    temperature?: number;
    audio: {
      input: {
        format: OpenAICompatibleRealtimeAudioFormat;
        transcription: { model: string; language?: string };
        turn_detection:
          | {
              type: "semantic_vad";
              eagerness: InworldRealtimeEagerness;
              create_response: true;
              interrupt_response: true;
            }
          | {
              type: "server_vad";
              threshold?: number;
              prefix_padding_ms?: number;
              silence_duration_ms?: number;
              create_response: true;
              interrupt_response: true;
            };
      };
      output: {
        format: OpenAICompatibleRealtimeAudioFormat;
        voice: string;
        model: string;
        speed?: number;
      };
    };
    providerData: {
      auto_tool_response: false;
      stt?: Record<string, unknown>;
      tts?: Record<string, unknown> & {
        delivery_mode?: InworldRealtimeDeliveryMode;
        steering_handling?: InworldRealtimeSteeringHandling;
        segmenter_strategy?: InworldRealtimeSegmenterStrategy;
      };
      memory?: Record<string, unknown>;
      responsiveness?: Record<string, unknown> & { enabled?: boolean };
    };
    tools?: RealtimeVoiceBridgeCreateRequest["tools"];
    tool_choice?: string;
  };
};

/** Inworld picks `google-ai-studio/gemini-2.5-flash` when `model` is omitted. */
export const INWORLD_REALTIME_DEFAULT_MODEL = "google-ai-studio/gemini-2.5-flash";
export const INWORLD_REALTIME_DEFAULT_VOICE = "Sarah";
export const INWORLD_REALTIME_DEFAULT_TTS_MODEL = "inworld-tts-2";
export const INWORLD_REALTIME_DEFAULT_STT_MODEL = "inworld/inworld-stt-1";
export const INWORLD_REALTIME_DEFAULT_EAGERNESS: InworldRealtimeEagerness = "medium";
export const INWORLD_REALTIME_CONNECT_TIMEOUT_MS = 10_000;
export const INWORLD_REALTIME_WS_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
export const INWORLD_REALTIME_MAX_PENDING_TOOL_RESULTS = 128;
export const INWORLD_REALTIME_MAX_PENDING_USER_MESSAGES = 128;
export const INWORLD_REALTIME_MAX_PENDING_PLAYBACK_MARKS = 1_024;
export const INWORLD_REALTIME_DEFAULT_VAD_THRESHOLD = 0.5;
export const INWORLD_REALTIME_DEFAULT_PREFIX_PADDING_MS = 300;
export const INWORLD_REALTIME_DEFAULT_SILENCE_DURATION_MS = 500;

export const INWORLD_REALTIME_VOICES = ["Sarah", "Clive", "Luna"] as const;

export function serializeInworldRealtimeToolResult(result: unknown): string {
  const message = "Inworld realtime voice tool result is not JSON-serializable";
  try {
    const serialized = JSON.stringify(result);
    if (typeof serialized === "string") {
      return serialized;
    }
  } catch (cause) {
    throw new Error(message, { cause });
  }
  throw new Error(message);
}

function readNestedInworldConfig(rawConfig: RealtimeVoiceProviderConfig) {
  const raw = readInworldObjectRecord(rawConfig);
  const providers = readInworldObjectRecord(raw?.providers);
  return readInworldObjectRecord(providers?.inworld ?? raw?.inworld ?? raw) ?? {};
}

export function normalizeInworldRealtimeBaseUrl(value?: string): string {
  return normalizeInworldBaseUrl(normalizeOptionalString(value));
}

function asInworldDurationMs(value: unknown): number | undefined {
  return asSafeIntegerInRange(value, { min: 0, max: 10_000 });
}

function asEnumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
  options: { uppercase?: boolean } = {},
): T | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  const candidate = options.uppercase ? normalized.toUpperCase() : normalized.toLowerCase();
  const match = allowed.find((entry) => entry === candidate);
  if (match !== undefined) {
    return match;
  }
  throw new Error(`Inworld realtime voice ${label} must be one of ${allowed.join(", ")}`);
}

function normalizeInworldRealtimeProviderData(
  value: unknown,
): InworldRealtimeProviderDataPassthrough | undefined {
  const raw = readInworldObjectRecord(value);
  if (!raw) {
    return undefined;
  }
  const passthrough: InworldRealtimeProviderDataPassthrough = {};
  for (const section of INWORLD_REALTIME_PROVIDER_DATA_SECTIONS) {
    const entry = readInworldObjectRecord(raw[section]);
    if (entry && Object.keys(entry).length > 0) {
      passthrough[section] = { ...entry };
    }
  }
  const unknownKeys = Object.keys(raw).filter(
    (key) => !INWORLD_REALTIME_PROVIDER_DATA_SECTIONS.some((section) => section === key),
  );
  if (unknownKeys.length > 0) {
    throw new Error(
      `Inworld realtime voice providerData only accepts the documented sections ${INWORLD_REALTIME_PROVIDER_DATA_SECTIONS.join(", ")}; unsupported: ${unknownKeys.join(", ")}`,
    );
  }
  if (Object.keys(passthrough).length === 0) {
    return undefined;
  }
  const bytes = Buffer.byteLength(JSON.stringify(passthrough), "utf8");
  if (bytes > INWORLD_REALTIME_PROVIDER_DATA_MAX_BYTES) {
    throw new Error(
      `Inworld realtime voice providerData exceeds ${INWORLD_REALTIME_PROVIDER_DATA_MAX_BYTES} bytes (${bytes})`,
    );
  }
  return passthrough;
}

export function normalizeInworldRealtimeProviderConfig(config: RealtimeVoiceProviderConfig) {
  const raw = readNestedInworldConfig(config);
  if (raw.backchannel !== undefined) {
    throw new Error(
      "Inworld realtime voice backchannel is not supported yet: the host realtime playback contract has no out-of-band audio channel for interjections",
    );
  }
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw.apiKey,
      path: "talk.realtime.providers.inworld.apiKey",
    }),
    baseUrl: normalizeOptionalString(raw.baseUrl),
    model: normalizeOptionalString(raw.model),
    voice: normalizeOptionalString(raw.voiceId ?? raw.speakerVoice ?? raw.voice),
    ttsModel: normalizeOptionalString(raw.ttsModel ?? raw.modelId),
    sttModel: normalizeOptionalString(raw.sttModel),
    speakingRate: asFiniteNumberInRange(raw.speakingRate ?? raw.speed, { min: 0.5, max: 1.5 }),
    temperature: asFiniteNumberInRange(raw.temperature, { min: 0, max: 2 }),
    deliveryMode: asEnumValue<InworldRealtimeDeliveryMode>(
      raw.deliveryMode,
      ["STABLE", "BALANCED", "CREATIVE"],
      "deliveryMode",
      { uppercase: true },
    ),
    steeringHandling: asEnumValue<InworldRealtimeSteeringHandling>(
      raw.steeringHandling,
      ["repeat_each_chunk", "emit_once"],
      "steeringHandling",
    ),
    segmenterStrategy: asEnumValue<InworldRealtimeSegmenterStrategy>(
      raw.segmenterStrategy,
      ["auto", "balanced", "sentence", "full_turn", "fast_start", "per_segment_context"],
      "segmenterStrategy",
    ),
    turnDetection: asEnumValue<InworldRealtimeTurnDetectionMode>(
      raw.turnDetection,
      ["semantic_vad", "server_vad"],
      "turnDetection",
    ),
    eagerness: asEnumValue<InworldRealtimeEagerness>(
      raw.eagerness,
      ["low", "medium", "high"],
      "eagerness",
    ),
    vadThreshold: asFiniteNumberInRange(raw.vadThreshold, { min: 0, max: 1 }),
    silenceDurationMs: asInworldDurationMs(raw.silenceDurationMs),
    prefixPaddingMs: asInworldDurationMs(raw.prefixPaddingMs),
    responsiveness: parseBooleanValue(raw.responsiveness),
    providerData: normalizeInworldRealtimeProviderData(raw.providerData),
    interruptResponseOnInputAudio: parseBooleanValue(raw.interruptResponseOnInputAudio),
  };
}

export function readInworldRealtimeErrorDetail(error: unknown): string {
  if (typeof error === "string" && error) {
    return error;
  }
  const record = readInworldObjectRecord(error);
  return (
    normalizeOptionalString(record?.message) ??
    normalizeOptionalString(record?.code) ??
    "Inworld realtime voice error"
  );
}

export function toInworldRealtimeWsUrl(baseUrl: string, sessionKey: string): string {
  const url = new URL(normalizeInworldRealtimeBaseUrl(baseUrl));
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/v1/realtime/session`;
  url.searchParams.set("key", sessionKey);
  url.searchParams.set("protocol", "realtime");
  return url.toString();
}
