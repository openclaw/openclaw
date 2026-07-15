// Discord plugin module implements preview streaming behavior.
import {
  resolveChannelPreviewStreamMode,
  resolveChannelStreamingBlockEnabled,
  type StreamingCompatEntry,
  type StreamingMode,
} from "openclaw/plugin-sdk/channel-outbound";

type DiscordLegacyBlockStreamingDefault = "off" | "on" | undefined;

function hasExplicitDiscordPreviewMode(
  account: StreamingCompatEntry | null | undefined,
): boolean {
  const streaming = account?.streaming;
  return Boolean(
    streaming &&
      typeof streaming === "object" &&
      !Array.isArray(streaming) &&
      Object.hasOwn(streaming, "mode"),
  );
}

export function resolveDiscordPreviewStreamMode(
  params: {
    streaming?: unknown;
  } = {},
): StreamingMode {
  if (params.streaming === undefined) {
    return "progress";
  }
  return resolveChannelPreviewStreamMode(params, "off");
}

export function resolveDiscordBlockStreamingEnabled(params: {
  account?: StreamingCompatEntry | null;
  previewAvailable: boolean;
  streamMode?: StreamingMode;
  legacyBlockStreamingDefault?: DiscordLegacyBlockStreamingDefault;
}): boolean {
  const explicitBlock = resolveChannelStreamingBlockEnabled(params.account);
  if (typeof explicitBlock === "boolean") {
    return explicitBlock;
  }
  const streamMode = params.streamMode ?? resolveDiscordPreviewStreamMode(params.account ?? {});
  const explicitPreviewAvailable =
    params.previewAvailable && hasExplicitDiscordPreviewMode(params.account) && streamMode !== "off";
  return !explicitPreviewAvailable && params.legacyBlockStreamingDefault === "on";
}
