import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { VoiceCallTtsConfig } from "./config.js";

/** Reads the active provider's preferred speaker from modern and legacy TTS config keys. */
function resolveProviderVoiceSetting(providerConfig: unknown): string | undefined {
  if (!providerConfig || typeof providerConfig !== "object") {
    return undefined;
  }
  const candidate = providerConfig as {
    speakerVoice?: unknown;
    speakerVoiceId?: unknown;
    voice?: unknown;
    voiceId?: unknown;
  };
  // Prefer the voice-call-specific keys, then fall back to legacy provider TTS keys
  // so existing per-provider configs keep selecting the same speaker.
  return (
    normalizeOptionalString(candidate.speakerVoice) ??
    normalizeOptionalString(candidate.speakerVoiceId) ??
    normalizeOptionalString(candidate.voice) ??
    normalizeOptionalString(candidate.voiceId)
  );
}

/**
 * Resolves the active telephony TTS provider's speaker hint for call metadata.
 *
 * Only the selected provider block is inspected so fallback-provider config does
 * not leak into the call's advertised/default voice.
 *
 * Legacy `voice`/`voiceId` keys stay readable because provider configs predate
 * the voice-call-specific `speakerVoice` fields.
 */
export function resolvePreferredTtsVoice(config: { tts?: VoiceCallTtsConfig }): string | undefined {
  const providerId = config.tts?.provider;
  if (!providerId) {
    return undefined;
  }
  // Only inspect the active provider block. Other provider voice settings may
  // be configured for fallback chains, but they should not bias call metadata.
  return resolveProviderVoiceSetting(config.tts?.providers?.[providerId]);
}
