import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

// Implicit default stays on the generateContent path; Gemini 3.8 is an explicit opt-in.
export const DEFAULT_GOOGLE_TTS_MODEL = "gemini-3.1-flash-tts-preview";
const DEFAULT_GOOGLE_TTS_VOICE = "Kore";
export const GOOGLE_AUDIO_PROFILE_PROMPT_TEMPLATE = "audio-profile-v1";

const GOOGLE_TTS_INTERACTIONS_MODELS = [
  "gemini-3.8-flash-tts",
  "gemini-3.8-flash-lite-tts",
] as const;

const GOOGLE_TTS_GENERATE_CONTENT_MODELS = [
  "gemini-3.1-flash-tts-preview",
  "gemini-2.5-flash-preview-tts",
  "gemini-2.5-pro-preview-tts",
] as const;

export const GOOGLE_TTS_MODELS = [
  ...GOOGLE_TTS_INTERACTIONS_MODELS,
  ...GOOGLE_TTS_GENERATE_CONTENT_MODELS,
] as const;

const GOOGLE_TTS_MODEL_ALIASES: Record<string, string> = {
  "gemini-3.1-flash-tts": "gemini-3.1-flash-tts-preview",
};

export function normalizeGoogleTtsModel(model: unknown): string {
  const trimmed = normalizeOptionalString(model);
  if (!trimmed) {
    return DEFAULT_GOOGLE_TTS_MODEL;
  }
  const withoutProvider = trimmed.startsWith("google/") ? trimmed.slice("google/".length) : trimmed;
  return GOOGLE_TTS_MODEL_ALIASES[withoutProvider] ?? withoutProvider;
}

export function isGoogleInteractionsTtsModel(model: string): boolean {
  // SAFETY: widening a readonly literal tuple to readonly string[] so includes() accepts any model id.
  return (GOOGLE_TTS_INTERACTIONS_MODELS as readonly string[]).includes(model);
}

export function assertSupportedGoogleTtsModel(model: string): void {
  if (isGoogleInteractionsTtsModel(model)) {
    return;
  }
  if (model.includes("gemini-3.8-") && model.includes("-tts")) {
    throw new Error(
      `Google TTS model ${model} is not supported. Gemini 3.8 TTS uses the Interactions API; supported models: ${GOOGLE_TTS_INTERACTIONS_MODELS.join(", ")}.`,
    );
  }
}

export function normalizeGoogleTtsVoiceName(voiceName: unknown): string {
  return normalizeOptionalString(voiceName) ?? DEFAULT_GOOGLE_TTS_VOICE;
}

export function normalizeGooglePromptTemplate(
  value: unknown,
): typeof GOOGLE_AUDIO_PROFILE_PROMPT_TEMPLATE | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === GOOGLE_AUDIO_PROFILE_PROMPT_TEMPLATE) {
    return trimmed;
  }
  throw new Error(`Invalid Google TTS promptTemplate: ${trimmed}`);
}
