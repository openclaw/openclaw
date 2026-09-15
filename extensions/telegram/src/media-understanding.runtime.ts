import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
// Telegram plugin module implements media understanding behavior.
import {
  describeImageWithModel as describeImageWithModelImpl,
  transcribeFirstAudio as transcribeFirstAudioImpl,
} from "openclaw/plugin-sdk/media-runtime";
import { createChannelPreflightAudio } from "openclaw/plugin-sdk/media-understanding-runtime";

type DescribeImageWithModel =
  typeof import("openclaw/plugin-sdk/media-runtime").describeImageWithModel;
type TranscribeFirstAudio = typeof import("openclaw/plugin-sdk/media-runtime").transcribeFirstAudio;

const telegramPreflightAudio = createChannelPreflightAudio({
  channel: "telegram",
  isAudio: (value: { kind?: string; contentType?: string }) =>
    value.kind === "audio" || value.contentType?.startsWith("audio/") === true,
  transcribeFirstAudio: transcribeFirstAudioImpl,
});

export async function describeImageWithModel(
  ...args: Parameters<DescribeImageWithModel>
): ReturnType<DescribeImageWithModel> {
  return await describeImageWithModelImpl(...args);
}

export async function resolveTelegramPreflightAudioTranscript(
  ...args: Parameters<TranscribeFirstAudio>
): ReturnType<TranscribeFirstAudio> {
  return await telegramPreflightAudio.resolve({ request: args[0] });
}

export async function sendTelegramPreflightAudioTranscriptEcho(params: {
  transcript: string;
  cfg: OpenClawConfig;
  accountId: string;
  originatingTo: string;
  messageThreadId?: string;
}): Promise<void> {
  await telegramPreflightAudio.send(params);
}
