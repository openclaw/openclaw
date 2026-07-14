// Elevenlabs plugin module implements shared behavior.
export const DEFAULT_ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";

export function isValidElevenLabsVoiceId(voiceId: string): boolean {
  return /^[a-zA-Z0-9]{10,40}$/.test(voiceId);
}

export function normalizeElevenLabsBaseUrl(
  baseUrl?: string,
  options?: { allowWebSocket?: boolean },
): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return DEFAULT_ELEVENLABS_BASE_URL;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Invalid ElevenLabs baseUrl: value is not a valid URL");
  }
  const allowedSchemes = options?.allowWebSocket
    ? new Set(["http:", "https:", "ws:", "wss:"])
    : new Set(["http:", "https:"]);
  if (!allowedSchemes.has(parsed.protocol)) {
    throw new Error(
      `Invalid ElevenLabs baseUrl: unsupported scheme "${parsed.protocol}" (expected ${options?.allowWebSocket ? "http, https, ws, or wss" : "http or https"})`,
    );
  }
  return trimmed.replace(/\/+$/, "");
}
