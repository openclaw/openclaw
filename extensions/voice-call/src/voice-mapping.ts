import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

/** Escapes user/model text before embedding it in TwiML or provider XML responses. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** OpenAI voice aliases accepted by config and translated for Twilio's Polly-backed TTS. */
const OPENAI_TO_POLLY_MAP: Record<string, string> = {
  alloy: "Polly.Joanna", // neutral, warm
  echo: "Polly.Matthew", // male, warm
  fable: "Polly.Amy", // British, expressive
  onyx: "Polly.Brian", // deep male
  nova: "Polly.Salli", // female, friendly
  shimmer: "Polly.Kimberly", // female, clear
};

/** Stable fallback voice used when config omits a voice or names an unsupported OpenAI alias. */
export const DEFAULT_POLLY_VOICE = "Polly.Joanna";

/**
 * Resolves config voice names to Twilio-compatible TTS voice ids.
 *
 * OpenAI aliases are case-insensitive; Polly/Google provider voice ids pass through unchanged.
 *
 * @param voice - OpenAI voice alias, Twilio Polly voice id, Google voice id, or undefined.
 * @returns TwiML voice id suitable for Twilio `<Say>`.
 */
export function mapVoiceToPolly(voice: string | undefined): string {
  if (!voice) {
    return DEFAULT_POLLY_VOICE;
  }

  // Preserve provider-qualified voice ids exactly; TwiML voice names are provider-owned strings.
  if (voice.startsWith("Polly.") || voice.startsWith("Google.")) {
    return voice;
  }

  // Unknown OpenAI-style names fall back instead of leaking unsupported voice ids to Twilio.
  return OPENAI_TO_POLLY_MAP[normalizeLowercaseStringOrEmpty(voice)] || DEFAULT_POLLY_VOICE;
}

/** Returns true only for the OpenAI aliases this plugin can translate for telephony TTS. */
export function isOpenAiVoice(voice: string): boolean {
  return normalizeLowercaseStringOrEmpty(voice) in OPENAI_TO_POLLY_MAP;
}

/** Lists supported OpenAI aliases in config-display order. */
export function getOpenAiVoiceNames(): string[] {
  return Object.keys(OPENAI_TO_POLLY_MAP);
}
