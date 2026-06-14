// Telegram plugin module implements media understanding behavior.
import {
  describeImageWithModel as describeImageWithModelImpl,
  transcribeFirstAudio as transcribeFirstAudioImpl,
  transcribeFirstAudioWithTelemetry as transcribeFirstAudioWithTelemetryImpl,
} from "openclaw/plugin-sdk/media-runtime";

type DescribeImageWithModel =
  typeof import("openclaw/plugin-sdk/media-runtime").describeImageWithModel;
type TranscribeFirstAudio = typeof import("openclaw/plugin-sdk/media-runtime").transcribeFirstAudio;
type TranscribeFirstAudioWithTelemetry =
  typeof import("openclaw/plugin-sdk/media-runtime").transcribeFirstAudioWithTelemetry;

export async function describeImageWithModel(
  ...args: Parameters<DescribeImageWithModel>
): ReturnType<DescribeImageWithModel> {
  return await describeImageWithModelImpl(...args);
}

export async function transcribeFirstAudio(
  ...args: Parameters<TranscribeFirstAudio>
): ReturnType<TranscribeFirstAudio> {
  return await transcribeFirstAudioImpl(...args);
}

export async function transcribeFirstAudioWithTelemetry(
  ...args: Parameters<TranscribeFirstAudioWithTelemetry>
): ReturnType<TranscribeFirstAudioWithTelemetry> {
  return await transcribeFirstAudioWithTelemetryImpl(...args);
}
