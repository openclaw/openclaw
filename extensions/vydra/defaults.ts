import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
export const DEFAULT_VYDRA_BASE_URL = "https://www.vydra.ai/api/v1";
export const DEFAULT_VYDRA_IMAGE_MODEL = "grok-imagine";
export const DEFAULT_VYDRA_VIDEO_MODEL = "veo3";
export const DEFAULT_VYDRA_SPEECH_MODEL = "elevenlabs/tts";
export const DEFAULT_VYDRA_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";

export function normalizeVydraBaseUrl(value: string | undefined): string {
  const trimmed = normalizeOptionalString(value);
  const url = trimmed ? URL.parse(trimmed) : null;
  if (!url) {
    return DEFAULT_VYDRA_BASE_URL;
  }
  if (url.hostname === "vydra.ai") {
    url.hostname = "www.vydra.ai";
  }
  url.pathname = url.pathname.replace(/\/+$/u, "") || "/api/v1";
  return url.toString().replace(/\/$/u, "");
}
