import {
  resolveChannelStreamingNativeTransport,
  resolveChannelPreviewStreamMode,
  type StreamingMode,
} from "openclaw/plugin-sdk/channel-streaming";

type TelegramPreviewStreamMode = StreamingMode;

export function resolveTelegramPreviewStreamMode(
  params: {
    streamMode?: unknown;
    streaming?: unknown;
  } = {},
): TelegramPreviewStreamMode {
  return resolveChannelPreviewStreamMode(params, "partial");
}

export function resolveTelegramNativeDraftStreamingEnabled(
  params: {
    nativeStreaming?: unknown;
    streaming?: unknown;
  } = {},
): boolean {
  return resolveChannelStreamingNativeTransport(params) === true;
}
