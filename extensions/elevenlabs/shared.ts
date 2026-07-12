// Elevenlabs plugin module implements shared behavior.
export const DEFAULT_ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";

export function isValidElevenLabsVoiceId(voiceId: string): boolean {
  return /^[a-zA-Z0-9]{10,40}$/.test(voiceId);
}

export function normalizeElevenLabsBaseUrl(baseUrl?: string): string {
  const trimmed = baseUrl?.trim().replace(/\/+$/, "");
  // Only an absent/blank value falls back to the default endpoint. An explicit
  // custom endpoint is the operator's intent, so reject it actionably here (at
  // the shared config boundary) rather than silently retargeting to the default
  // or letting a downstream `new URL(...)` throw an opaque TypeError.
  if (!trimmed) {
    return DEFAULT_ELEVENLABS_BASE_URL;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid ElevenLabs baseUrl: ${trimmed}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Invalid ElevenLabs baseUrl (expected http/https): ${trimmed}`);
  }
  return trimmed;
}
