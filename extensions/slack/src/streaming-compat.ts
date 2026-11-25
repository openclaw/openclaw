import {
  getChannelStreamingConfigObject,
  resolveChannelStreamingNativeTransport,
} from "openclaw/plugin-sdk/channel-streaming-config";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

export function resolveSlackStreamingMode(
  params: { streamMode?: unknown; streaming?: unknown } = {},
) {
  const mode = normalizeLowercaseStringOrEmpty(
    getChannelStreamingConfigObject(params)?.mode ?? params.streaming,
  );
  if (mode === "off" || mode === "partial" || mode === "block" || mode === "progress") {
    return mode;
  }
  switch (normalizeLowercaseStringOrEmpty(params.streamMode)) {
    case "append":
      return "block";
    case "status_final":
      return "progress";
    case "replace":
      return "partial";
    default:
      return typeof params.streaming === "boolean"
        ? params.streaming
          ? "partial"
          : "off"
        : "progress";
  }
}

export function resolveSlackNativeStreaming(
  params: { nativeStreaming?: unknown; streaming?: unknown } = {},
): boolean {
  return (
    resolveChannelStreamingNativeTransport(params) ??
    (typeof params.nativeStreaming === "boolean"
      ? params.nativeStreaming
      : typeof params.streaming === "boolean"
        ? params.streaming
        : true)
  );
}
