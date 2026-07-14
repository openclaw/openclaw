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
  return trimmed.replace(/\/+$/u, "");
}
