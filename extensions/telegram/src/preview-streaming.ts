// Telegram plugin module implements preview streaming behavior.
import {
  resolveChannelPreviewStreamMode,
  resolveChannelStreamingBlockEnabled,
  type StreamingCompatEntry,
  type StreamingMode,
} from "openclaw/plugin-sdk/channel-outbound";

type TelegramPreviewStreamMode = StreamingMode;
type TelegramLegacyBlockStreamingDefault = "off" | "on" | undefined;

export function resolveTelegramPreviewStreamMode(
  params: {
    streamMode?: unknown;
    streaming?: unknown;
  } = {},
): TelegramPreviewStreamMode {
  return resolveChannelPreviewStreamMode(params, "partial");
}

export function resolveTelegramBlockStreamingEnabled(params: {
  account?: StreamingCompatEntry | null;
  streamMode?: TelegramPreviewStreamMode;
  legacyBlockStreamingDefault?: TelegramLegacyBlockStreamingDefault;
}): boolean {
  const explicitBlock = resolveChannelStreamingBlockEnabled(params.account);
  if (typeof explicitBlock === "boolean") {
    return explicitBlock;
  }

  const streamMode = params.streamMode ?? resolveTelegramPreviewStreamMode(params.account ?? {});
  if (streamMode === "partial" || streamMode === "progress") {
    return false;
  }
  return params.legacyBlockStreamingDefault === "on";
}
