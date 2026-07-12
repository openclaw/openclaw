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
    // Do not interpolate the raw value: an explicit baseUrl may embed userinfo
    // (https://user:token@host) or credential-bearing query params that would
    // otherwise leak into logs/diagnostics via this error.
    throw new Error("Invalid ElevenLabs baseUrl: value is not a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    // Only the scheme is safe to surface; the rest of the URL may carry secrets.
    throw new Error(
      `Invalid ElevenLabs baseUrl: unsupported scheme "${parsed.protocol}" (expected http or https)`,
    );
  }
  return trimmed;
}
