import type { VoiceCallTtsConfig } from "./config.js";

function resolveProviderVoiceSetting(providerConfig: unknown): string | undefined {
  if (!providerConfig || typeof providerConfig !== "object") {
    return undefined;
  }
  const candidate = providerConfig as {
    voice?: unknown;
    voiceId?: unknown;
  };
  if (typeof candidate.voice === "string" && candidate.voice.trim()) {
    return candidate.voice;
  }
  if (typeof candidate.voiceId === "string" && candidate.voiceId.trim()) {
    return candidate.voiceId;
  }
  return undefined;
}

export function resolvePreferredTtsVoice(config: { tts?: VoiceCallTtsConfig }): string | undefined {
  const providerId = config.tts?.provider;
  if (!providerId) {
    return undefined;
  }
  return resolveProviderVoiceSetting(config.tts?.providers?.[providerId]);
}
