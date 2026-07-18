// Elevenlabs plugin module implements shared behavior.
export const DEFAULT_ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";

export function isValidElevenLabsVoiceId(voiceId: string): boolean {
  return /^[a-zA-Z0-9]{10,40}$/.test(voiceId);
}

export function normalizeElevenLabsBaseUrl(baseUrl?: string): string {
  const trimmed = (baseUrl ?? "").trim();
  if (!trimmed) {
    return DEFAULT_ELEVENLABS_BASE_URL;
  }
  const parsed = (() => {
    try {
      return new URL(trimmed);
    } catch {
      throw new Error("Invalid ElevenLabs baseUrl: value is not a valid URL");
    }
  })();
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Invalid ElevenLabs baseUrl: unsupported scheme "${parsed.protocol}" ` +
        "(expected http or https)",
    );
  }
  if (parsed.search) {
    throw new Error("Invalid ElevenLabs baseUrl: query string is not supported");
  }
  if (parsed.hash) {
    throw new Error("Invalid ElevenLabs baseUrl: fragment is not supported");
  }
  // Preserve userinfo so proxy credentials (https://user:pass@host)
  // survive normalization.
  const auth = parsed.username
    ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ""}@`
    : "";
  const clean = `${parsed.protocol}//${auth}${parsed.host}${parsed.pathname}`.replace(/\/+$/u, "");
  return clean || `${parsed.protocol}//${parsed.host}`;
}
