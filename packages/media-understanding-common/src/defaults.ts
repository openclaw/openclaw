import type { MediaUnderstandingCapability, MediaUnderstandingKind } from "./types.js";

const MB = 1024 * 1024;

/** Default max response characters for bounded text outputs. */
export const DEFAULT_MAX_CHARS = 500;
/** Default limits, prompt, and output kind for each media capability. */
export const MEDIA_CAPABILITY_DEFAULTS: Record<
  MediaUnderstandingCapability,
  {
    maxChars: number | undefined;
    maxBytes: number;
    timeoutSeconds: number;
    prompt: string;
    kind: MediaUnderstandingKind;
  }
> = {
  image: {
    maxChars: DEFAULT_MAX_CHARS,
    maxBytes: 10 * MB,
    timeoutSeconds: 60,
    prompt: "Describe the image.",
    kind: "image.description",
  },
  audio: {
    maxChars: undefined,
    maxBytes: 20 * MB,
    timeoutSeconds: 60,
    prompt: "Transcribe the audio.",
    kind: "audio.transcription",
  },
  video: {
    maxChars: DEFAULT_MAX_CHARS,
    maxBytes: 50 * MB,
    timeoutSeconds: 120,
    prompt: "Describe the video.",
    kind: "video.description",
  },
};
/** Upper bound for base64-expanded video payloads. */
export const DEFAULT_VIDEO_MAX_BASE64_BYTES = 70 * MB;
/** CLI output buffer used by provider child processes. */
export const CLI_OUTPUT_MAX_BUFFER = 5 * MB;
/** Default parallel media-understanding request count. */
export const DEFAULT_MEDIA_CONCURRENCY = 2;
/** Minimum bytes for audio files before transcription is attempted. */
export const MIN_AUDIO_FILE_BYTES = 1024;
