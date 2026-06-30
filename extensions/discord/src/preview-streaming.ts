// Discord plugin module implements preview streaming behavior.
import {
  resolveChannelPreviewStreamMode,
  resolveChannelStreamingBlockEnabled,
  type StreamingCompatEntry,
  type StreamingMode,
} from "openclaw/plugin-sdk/channel-outbound";

type DiscordPreviewStreamMode = StreamingMode;
type DiscordLegacyBlockStreamingDefault = "off" | "on" | undefined;

export function resolveDiscordPreviewStreamMode(
  params: {
    streamMode?: unknown;
    streaming?: unknown;
  } = {},
): DiscordPreviewStreamMode {
  if (params.streaming === undefined && params.streamMode === undefined) {
    return "progress";
  }
  return resolveChannelPreviewStreamMode(params, "off");
}

export function resolveDiscordBlockStreamingEnabled(params: {
  account?: StreamingCompatEntry | null;
  streamMode?: DiscordPreviewStreamMode;
  legacyBlockStreamingDefault?: DiscordLegacyBlockStreamingDefault;
}): boolean {
  const explicitBlock = resolveChannelStreamingBlockEnabled(params.account);
  if (typeof explicitBlock === "boolean") {
    return explicitBlock;
  }

  const streamMode = params.streamMode ?? resolveDiscordPreviewStreamMode(params.account ?? {});
  if (streamMode !== "off") {
    return false;
  }
  return params.legacyBlockStreamingDefault === "on";
}
