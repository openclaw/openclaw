// Elevenlabs plugin module implements shared behavior.
export const DEFAULT_ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";

export function isValidElevenLabsVoiceId(voiceId: string): boolean {
  return /^[a-zA-Z0-9]{10,40}$/.test(voiceId);
}

export function normalizeElevenLabsBaseUrl(baseUrl?: string): string {
  const trimmed = baseUrl?.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return DEFAULT_ELEVENLABS_BASE_URL;
  }
  // Callers pass the result straight into `new URL(...)`; a malformed value
  // (e.g. "not a url") would otherwise throw an uncaught TypeError downstream.
  // Fall back to the default endpoint instead of propagating an unparseable URL.
  try {
    void new URL(trimmed);
  } catch {
    return DEFAULT_ELEVENLABS_BASE_URL;
  }
  return trimmed;
}
