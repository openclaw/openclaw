import { canonicalizeBase64 } from "openclaw/plugin-sdk/media-runtime";

export function canonicalizeVoiceCallMediaBase64(payloadBase64: string): string | undefined {
  return canonicalizeBase64(payloadBase64.replaceAll("-", "+").replaceAll("_", "/"));
}
