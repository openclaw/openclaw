// Discord plugin module implements preview streaming behavior.
import {
  resolveChannelPreviewStreamMode,
  type StreamingMode,
} from "openclaw/plugin-sdk/channel-outbound";

export function resolveDiscordPreviewStreamMode(
  params: {
    streaming?: unknown;
    sessionStreamingMode?: unknown;
  } = {},
): StreamingMode {
  const sessionMode =
    params.sessionStreamingMode === "off" ||
    params.sessionStreamingMode === "partial" ||
    params.sessionStreamingMode === "block" ||
    params.sessionStreamingMode === "progress"
      ? params.sessionStreamingMode
      : undefined;
  if (params.streaming === undefined && sessionMode === undefined) {
    return "progress";
  }
  return resolveChannelPreviewStreamMode(params, "off", {
    sessionMode,
  });
}
