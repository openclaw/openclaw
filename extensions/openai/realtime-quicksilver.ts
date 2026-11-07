import type { RealtimeVoiceProviderCapabilities } from "openclaw/plugin-sdk/realtime-voice";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
// Realtime voice uses browser or Gateway-owned WebRTC when the host owns delegation,
// and the Platform-key direct WebSocket transport elsewhere.

export const OPENAI_GPT_LIVE_MODEL_PREFIX = "gpt-live";

export const OPENAI_GPT_LIVE_MODELS = ["gpt-live-1", "gpt-live-1-codex"] as const;
const OPENAI_GPT_LIVE_API_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "beacon",
  "bossa",
  "cedar",
  "cinder",
  "coral",
  "delta",
  "echo",
  "gleam",
  "marin",
  "meridian",
  "quartz",
  "ripple",
  "sage",
  "shimmer",
  "stone",
  "tempo",
  "verse",
  "vesper",
  "willow",
] as const;
const OPENAI_GPT_LIVE_VOICES = [
  "arbor",
  "breeze",
  "cove",
  "ember",
  "juniper",
  "maple",
  "sol",
  "spruce",
  "vale",
] as const;
const OPENAI_GPT_LIVE_UNLISTED_VOICES = ["marin", "cedar"] as const;
type OpenAIGptLiveVoice =
  | (typeof OPENAI_GPT_LIVE_API_VOICES)[number]
  | (typeof OPENAI_GPT_LIVE_VOICES)[number]
  | (typeof OPENAI_GPT_LIVE_UNLISTED_VOICES)[number];
export type OpenAIGptLiveCustomVoice = { id: string };
export type OpenAIGptLiveVoiceSelection = OpenAIGptLiveVoice | OpenAIGptLiveCustomVoice;

const OPENAI_GPT_LIVE_CUSTOM_VOICE_ID_PREFIX = "voice_";
const OPENAI_GPT_LIVE_CUSTOM_VOICE_ID_RE = /^voice_[A-Za-z0-9_-]+$/;
// Never echo the configured reference.
const OPENAI_GPT_LIVE_CUSTOM_VOICE_INVALID =
  'Invalid GPT-Live custom voice reference: expected { id: "voice_..." }';

export function isOpenAIGptLiveApiModel(model: string | undefined): boolean {
  return model?.trim().toLowerCase() === "gpt-live-1";
}

export function isOpenAIGptLiveSubscriptionModel(model: string | undefined): boolean {
  return model?.trim().toLowerCase() === "gpt-live-1-codex";
}

export function isSupportedOpenAIGptLiveModel(model: string | undefined): boolean {
  return isOpenAIGptLiveApiModel(model) || isOpenAIGptLiveSubscriptionModel(model);
}

/**
 * Reads a configured voice name or saved voice ID without validating the ID, so config
 * and catalog reads never fail on it. Talk and channel callers pass `speakerVoiceId`
 * through the same string field; saved IDs keep their case and stay out of string-only
 * public projections.
 */
export function readOpenAIQuicksilverVoiceSetting(
  value: unknown,
): string | OpenAIGptLiveCustomVoice | undefined {
  const record = asOptionalRecord(value);
  if (record && "id" in record) {
    // Normalized configs re-enter here; an invalid shape keeps failing session validation.
    const id =
      typeof record.id === "string" && Object.keys(record).length === 1 ? record.id.trim() : "";
    return { id };
  }
  const trimmed = normalizeOptionalString(value);
  // A mistyped prefix must fail session validation, not lowercase into a saved ID.
  if (trimmed?.toLowerCase().startsWith(OPENAI_GPT_LIVE_CUSTOM_VOICE_ID_PREFIX)) {
    return { id: trimmed };
  }
  return trimmed?.toLowerCase();
}

/** Validates a voice setting at session creation. */
export function normalizeOpenAIQuicksilverVoiceInput(
  value: unknown,
): string | OpenAIGptLiveCustomVoice | undefined {
  const setting = readOpenAIQuicksilverVoiceSetting(value);
  return typeof setting === "object" ? parseOpenAIGptLiveCustomVoiceId(setting.id) : setting;
}

function parseOpenAIGptLiveCustomVoiceId(id: string): OpenAIGptLiveCustomVoice {
  if (!OPENAI_GPT_LIVE_CUSTOM_VOICE_ID_RE.test(id)) {
    throw new Error(OPENAI_GPT_LIVE_CUSTOM_VOICE_INVALID);
  }
  return { id };
}

/** Prompt-created voices are a public GPT-Live capability; other routes fail closed. */
export function assertOpenAIGptLiveCustomVoiceModel(
  model: string | undefined,
  voice: string | OpenAIGptLiveCustomVoice | undefined,
): void {
  if (typeof voice === "object" && !isOpenAIGptLiveApiModel(model)) {
    throw new Error("GPT-Live custom voice references require model gpt-live-1");
  }
}

export function resolveOpenAIQuicksilverVoice(
  model: string,
  value: unknown,
): OpenAIGptLiveVoiceSelection {
  const voices = resolveOpenAIQuicksilverVoices(model);
  const defaultVoice = isOpenAIGptLiveSubscriptionModel(model) ? "cove" : "marin";
  const normalized = normalizeOpenAIQuicksilverVoiceInput(value);
  if (typeof normalized === "object") {
    assertOpenAIGptLiveCustomVoiceModel(model, normalized);
    return normalized;
  }
  return voices.find((voice) => voice === normalized) ?? defaultVoice;
}

function resolveOpenAIQuicksilverVoices(model: string): readonly OpenAIGptLiveVoice[] {
  if (isOpenAIGptLiveApiModel(model)) {
    return OPENAI_GPT_LIVE_API_VOICES;
  }
  return isOpenAIGptLiveSubscriptionModel(model)
    ? OPENAI_GPT_LIVE_VOICES
    : OPENAI_GPT_LIVE_UNLISTED_VOICES;
}

export function isOpenAIGptLiveModel(model: string | undefined): boolean {
  if (!model) {
    return false;
  }
  const normalized = model.trim().toLowerCase();
  return (
    normalized === OPENAI_GPT_LIVE_MODEL_PREFIX ||
    normalized.startsWith(`${OPENAI_GPT_LIVE_MODEL_PREFIX}-`)
  );
}

export const OPENAI_QUICKSILVER_CAPABILITIES = {
  transports: ["webrtc" as const, "gateway-relay" as const],
  handlesAgentConsult: true as const,
  supportsBargeIn: false,
  handlesInputAudioBargeIn: true,
  supportsActivationNameGating: false,
  supportsToolCalls: false,
  supportsVideoFrames: false,
} satisfies Partial<RealtimeVoiceProviderCapabilities> & { handlesAgentConsult: true };

export function resolveOpenAIQuicksilverVoiceCapabilities(model: string): {
  voices: readonly string[];
  voiceSelectionPolicy: "allowlist-default";
} {
  return {
    voices: resolveOpenAIQuicksilverVoices(model),
    voiceSelectionPolicy: "allowlist-default",
  };
}
