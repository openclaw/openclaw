// Google Meet audio bridges exchange raw PCM chunks as base64 across node.invoke.
import { canonicalizeBase64 } from "openclaw/plugin-sdk/media-runtime";

function decodeGoogleMeetAudioBase64(base64: string): Buffer | undefined {
  const canonicalBase64 = canonicalizeBase64(base64);
  return canonicalBase64 ? Buffer.from(canonicalBase64, "base64") : undefined;
}

export function readGoogleMeetAudioBase64(base64: string, action: string): Buffer {
  const audio = decodeGoogleMeetAudioBase64(base64);
  if (!audio) {
    throw new Error(`${action} base64 must be a valid audio payload`);
  }
  return audio;
}

export function isGoogleMeetAudioBase64(value: string): boolean {
  return decodeGoogleMeetAudioBase64(value) !== undefined;
}
