import {
  transcribeFirstAudio as transcribeFirstAudioImpl,
  transcribeFirstAudioResult as transcribeFirstAudioResultImpl,
} from "openclaw/plugin-sdk/media-runtime";

type TranscribeFirstAudio = typeof import("openclaw/plugin-sdk/media-runtime").transcribeFirstAudio;
type TranscribeFirstAudioResult =
  typeof import("openclaw/plugin-sdk/media-runtime").transcribeFirstAudioResult;

export async function transcribeFirstAudio(
  ...args: Parameters<TranscribeFirstAudio>
): ReturnType<TranscribeFirstAudio> {
  return await transcribeFirstAudioImpl(...args);
}

export async function transcribeFirstAudioResult(
  ...args: Parameters<TranscribeFirstAudioResult>
): ReturnType<TranscribeFirstAudioResult> {
  return await transcribeFirstAudioResultImpl(...args);
}
