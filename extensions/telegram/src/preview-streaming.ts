// Telegram plugin module implements preview streaming behavior.
import {
  resolveChannelPreviewStreamMode,
  type StreamingMode,
} from "openclaw/plugin-sdk/channel-outbound";

type TelegramPreviewStreamMode = StreamingMode;

export function resolveTelegramPreviewStreamMode(
  params: {
    streamMode?: unknown;
    streaming?: unknown;
    sessionStreamingMode?: unknown;
  } = {},
): TelegramPreviewStreamMode {
  return resolveChannelPreviewStreamMode(params, "partial", {
    sessionMode: params.sessionStreamingMode,
  });
}
