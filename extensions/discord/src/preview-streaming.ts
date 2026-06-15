// Discord plugin module implements preview streaming behavior.
import {
  resolveChannelPreviewStreamMode,
  type StreamingMode,
} from "openclaw/plugin-sdk/channel-outbound";

type DiscordPreviewStreamMode = StreamingMode;

export function resolveDiscordPreviewStreamMode(
  params: {
    streamMode?: unknown;
    streaming?: unknown;
    sessionStreamingMode?: unknown;
  } = {},
): DiscordPreviewStreamMode {
  if (params.sessionStreamingMode !== undefined) {
    return resolveChannelPreviewStreamMode(params, "off", {
      sessionMode: params.sessionStreamingMode,
    });
  }
  if (params.streaming === undefined && params.streamMode === undefined) {
    return "progress";
  }
  return resolveChannelPreviewStreamMode(params, "off");
}
