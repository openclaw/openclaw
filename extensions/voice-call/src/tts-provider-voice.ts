import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { VoiceCallTtsConfig } from "./config.js";

/** Resolve the active provider's preferred voice id/name from voice-call TTS config. */
export function resolvePreferredTtsVoice(config: { tts?: VoiceCallTtsConfig }): string | undefined {
  const providerId = config.tts?.provider;
  const candidate = providerId ? config.tts?.providers?.[providerId] : undefined;
  return (
    normalizeOptionalString(candidate?.speakerVoice) ??
    normalizeOptionalString(candidate?.speakerVoiceId) ??
    normalizeOptionalString(candidate?.voice) ??
    normalizeOptionalString(candidate?.voiceId)
  );
}
