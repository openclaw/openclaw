/**
 * Voice mapping and XML utilities for voice call providers.
 */

/**
 * Escape XML special characters for TwiML and other XML responses.
 */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Map of OpenAI voice names to similar Twilio Polly voices.
 */
const OPENAI_TO_POLLY_MAP: Record<string, string> = {
  alloy: "Polly.Joanna", // neutral, warm
  echo: "Polly.Matthew", // male, warm
  fable: "Polly.Amy", // British, expressive
  onyx: "Polly.Brian", // deep male
  nova: "Polly.Salli", // female, friendly
  shimmer: "Polly.Kimberly", // female, clear
};

/**
 * Default Polly voice when no mapping is found.
 */
export const DEFAULT_POLLY_VOICE = "Polly.Joanna";

/**
 * Default Polly voice for Korean text.
 * Polly.Seoyeon is the only AWS Polly voice with native Korean support.
 */
export const DEFAULT_POLLY_VOICE_KO = "Polly.Seoyeon";

/**
 * Detect if text is predominantly Korean (Hangul characters).
 * Used to automatically select an appropriate TTS voice.
 *
 * @param text - Input text to check
 * @returns true if more than 20% of characters are Hangul
 */
export function isKoreanText(text: string): boolean {
  if (!text || text.length === 0) return false;
  const hangulCount = (text.match(/[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F]/g) || []).length;
  return hangulCount / text.length > 0.2;
}

/**
 * Map OpenAI voice names to Twilio Polly equivalents.
 * Falls through if already a valid Polly/Google voice.
 * Automatically selects Polly.Seoyeon for Korean text when no voice is specified.
 *
 * @param voice - OpenAI voice name (alloy, echo, etc.) or Polly voice name
 * @param text - Optional text content used for language auto-detection
 * @returns Polly voice name suitable for Twilio TwiML
 */
export function mapVoiceToPolly(voice: string | undefined, text?: string): string {
  if (!voice) {
    // Auto-detect Korean and use Seoyeon for natural Korean TTS
    if (text && isKoreanText(text)) {
      return DEFAULT_POLLY_VOICE_KO;
    }
    return DEFAULT_POLLY_VOICE;
  }

  // Already a Polly/Google voice - pass through
  if (voice.startsWith("Polly.") || voice.startsWith("Google.")) {
    return voice;
  }

  // Map OpenAI voices to Polly equivalents
  return OPENAI_TO_POLLY_MAP[voice.toLowerCase()] || DEFAULT_POLLY_VOICE;
}

/**
 * Check if a voice name is a known OpenAI voice.
 */
export function isOpenAiVoice(voice: string): boolean {
  return voice.toLowerCase() in OPENAI_TO_POLLY_MAP;
}

/**
 * Get all supported OpenAI voice names.
 */
export function getOpenAiVoiceNames(): string[] {
  return Object.keys(OPENAI_TO_POLLY_MAP);
}
