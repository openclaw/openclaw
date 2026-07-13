import { canonicalizeBase64 } from "openclaw/plugin-sdk/media-runtime";

export function canonicalizeVoiceCallMediaBase64(payloadBase64: string): string | undefined {
  return canonicalizeBase64(payloadBase64);
}

export function decodeVoiceCallMediaBase64(payloadBase64: string, context: string): Buffer {
  const canonicalBase64 = canonicalizeVoiceCallMediaBase64(payloadBase64);
  if (!canonicalBase64) {
    throw new Error(`${context} media payload was not valid base64`);
  }
  return Buffer.from(canonicalBase64, "base64");
}
