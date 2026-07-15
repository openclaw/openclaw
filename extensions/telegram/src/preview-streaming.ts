// Telegram plugin module implements preview streaming behavior.
import {
  resolveChannelPreviewStreamMode,
  resolveChannelStreamingBlockEnabled,
  type StreamingCompatEntry,
  type StreamingMode,
} from "openclaw/plugin-sdk/channel-outbound";

type TelegramLegacyBlockStreamingDefault = "off" | "on" | undefined;

function hasExplicitTelegramPreviewMode(
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

export function resolveTelegramPreviewStreamMode(
  params: {
    streaming?: unknown;
  } = {},
): StreamingMode {
  return resolveChannelPreviewStreamMode(params, "partial");
}

export function resolveTelegramBlockStreamingEnabled(params: {
  account?: StreamingCompatEntry | null;
  previewAvailable: boolean;
  streamMode?: StreamingMode;
  legacyBlockStreamingDefault?: TelegramLegacyBlockStreamingDefault;
}): boolean {
  const explicitBlock = resolveChannelStreamingBlockEnabled(params.account);
  if (typeof explicitBlock === "boolean") {
    return explicitBlock;
  }
  const streamMode = params.streamMode ?? resolveTelegramPreviewStreamMode(params.account ?? {});
  const explicitPreviewAvailable =
    params.previewAvailable && hasExplicitTelegramPreviewMode(params.account) && streamMode !== "off";
  return !explicitPreviewAvailable && params.legacyBlockStreamingDefault === "on";
}
