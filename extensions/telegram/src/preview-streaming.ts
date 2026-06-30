// Telegram plugin module implements preview streaming behavior.
import {
  resolveChannelPreviewStreamMode,
  resolveChannelStreamingBlockEnabled,
  type StreamingCompatEntry,
  type StreamingMode,
} from "openclaw/plugin-sdk/channel-outbound";

type TelegramPreviewStreamMode = StreamingMode;
type TelegramLegacyBlockStreamingDefault = "off" | "on" | undefined;

function hasExplicitTelegramPreviewStreamMode(
  account: StreamingCompatEntry | null | undefined,
): boolean {
  if (!account) {
    return false;
  }
  if (typeof account.streaming === "boolean" || typeof account.streaming === "string") {
    return true;
  }
  if (typeof account.streamMode === "string") {
    return true;
  }
  return (
    account.streaming !== null &&
    typeof account.streaming === "object" &&
    !Array.isArray(account.streaming) &&
    Object.hasOwn(account.streaming, "mode")
  );
}

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

  const streamMode =
    hasExplicitTelegramPreviewStreamMode(params.account) ?
      (params.streamMode ?? resolveTelegramPreviewStreamMode(params.account ?? {}))
    : "off";
  if (streamMode !== "off") {
    return false;
  }
  return params.legacyBlockStreamingDefault === "on";
}
