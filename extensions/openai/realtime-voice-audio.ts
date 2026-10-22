import { canonicalizeBase64 } from "openclaw/plugin-sdk/realtime-voice-provider";

export class OpenAIRealtimeMalformedAudioError extends Error {}

export function base64ToBuffer(b64: string): Buffer {
  const canonicalAudio = canonicalizeBase64(b64);
  if (!canonicalAudio) {
    throw new OpenAIRealtimeMalformedAudioError(
      "OpenAI realtime stream returned malformed base64 audio data",
    );
  }
  return Buffer.from(canonicalAudio, "base64");
}
