import { formatMediaPlaceholderText } from "openclaw/plugin-sdk/channel-inbound";
import { timestampMsToIsoString } from "openclaw/plugin-sdk/number-runtime";
import type { TelegramMediaRef } from "./bot-message-context.types.js";
import type { TelegramMediaKind, TelegramReplyTarget } from "./bot/helpers.js";
import type { TelegramReplyChainEntry } from "./message-cache-codec.js";
import { resolveTelegramPromptMediaPath } from "./prompt-media-path.js";

export function replyTargetToChainEntry(
  replyTarget: TelegramReplyTarget,
  media?: TelegramMediaRef,
): TelegramReplyChainEntry {
  return {
    ...(replyTarget.id ? { messageId: replyTarget.id } : {}),
    sender: replyTarget.sender,
    ...(replyTarget.senderId ? { senderId: replyTarget.senderId } : {}),
    ...(replyTarget.senderUsername ? { senderUsername: replyTarget.senderUsername } : {}),
    ...(replyTarget.body ? { body: replyTarget.body } : {}),
    ...(replyTarget.mediaType
      ? { mediaKind: replyTarget.mediaType, mediaType: replyTarget.mediaType }
      : {}),
    ...(media?.path
      ? {
          mediaPath: media.path,
          mediaKind: media.kind,
          ...(media.contentType ? { mediaType: media.contentType } : {}),
        }
      : {}),
    ...(replyTarget.kind === "quote" ? { isQuote: true } : {}),
    ...(replyTarget.forwardedFrom?.from ? { forwardedFrom: replyTarget.forwardedFrom.from } : {}),
    ...(replyTarget.forwardedFrom?.fromId
      ? { forwardedFromId: replyTarget.forwardedFrom.fromId }
      : {}),
    ...(replyTarget.forwardedFrom?.fromUsername
      ? { forwardedFromUsername: replyTarget.forwardedFrom.fromUsername }
      : {}),
    ...(replyTarget.forwardedFrom?.date
      ? { forwardedDate: replyTarget.forwardedFrom.date * 1000 }
      : {}),
  };
}

export function stripReplyChainForwarded(entry: TelegramReplyChainEntry): TelegramReplyChainEntry {
  const {
    forwardedFrom: _forwardedFrom,
    forwardedFromId: _forwardedFromId,
    forwardedFromUsername: _forwardedFromUsername,
    forwardedDate: _forwardedDate,
    ...withoutForwarded
  } = entry;
  return withoutForwarded;
}

export function formatTelegramForwardedMessageBody(params: {
  body: string;
  forwardedFrom?: string;
  forwardedDate?: number;
}): string {
  const forwardedAt = timestampMsToIsoString(params.forwardedDate);
  const forwardPrefix = params.forwardedFrom
    ? `[Forwarded from ${params.forwardedFrom}${forwardedAt ? ` at ${forwardedAt}` : ""}]`
    : undefined;
  return [forwardPrefix, params.body].filter(Boolean).join("\n");
}

export function formatReplyChainEntry(entry: TelegramReplyChainEntry, index: number): string {
  const mediaPath = entry.mediaPath ? resolveTelegramPromptMediaPath(entry.mediaPath) : undefined;
  const labels = [
    `${index + 1}. ${entry.sender ?? "unknown sender"}`,
    entry.messageId ? `id:${entry.messageId}` : undefined,
    entry.replyToId ? `reply_to:${entry.replyToId}` : undefined,
    entry.timestamp ? timestampMsToIsoString(entry.timestamp) : undefined,
  ].filter(Boolean);
  const bodyLines = [
    formatTelegramForwardedMessageBody({
      body: entry.isQuote && entry.body ? `"${entry.body}"` : (entry.body ?? ""),
      forwardedFrom: entry.forwardedFrom,
      forwardedDate: entry.forwardedDate,
    }),
    entry.mediaKind || entry.mediaType
      ? formatMediaPlaceholderText([
          entry.mediaKind
            ? { kind: entry.mediaKind }
            : entry.mediaType && isTelegramMediaKind(entry.mediaType)
              ? { kind: entry.mediaType }
              : { contentType: entry.mediaType },
        ])
      : undefined,
    mediaPath ? `[media_path:${mediaPath}]` : undefined,
    entry.mediaRef ? `[media_ref:${entry.mediaRef}]` : undefined,
  ].filter(Boolean);
  return `[${labels.join(" ")}]\n${bodyLines.join("\n")}`;
}

const TELEGRAM_MEDIA_KINDS: ReadonlySet<string> = new Set<TelegramMediaKind>([
  "audio",
  "document",
  "image",
  "sticker",
  "video",
]);

export function isTelegramMediaKind(value: string): value is TelegramMediaKind {
  return TELEGRAM_MEDIA_KINDS.has(value);
}
