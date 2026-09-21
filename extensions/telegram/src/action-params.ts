import {
  readPositiveIntegerParam,
  readStringOrNumberParam,
} from "openclaw/plugin-sdk/channel-actions";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const TELEGRAM_FORUM_TOPIC_ICON_COLORS = [
  0x6fb9f0, 0xffd67e, 0xcb86db, 0x8eee98, 0xff93b2, 0xfb6f5f,
] as const;
type TelegramForumTopicIconColor = (typeof TELEGRAM_FORUM_TOPIC_ICON_COLORS)[number];

export function readTelegramForumTopicIconColor(
  params: Record<string, unknown>,
): TelegramForumTopicIconColor | undefined {
  const iconColor = readPositiveIntegerParam(params, "iconColor", {
    message: "iconColor must be one of Telegram's supported forum topic colors.",
  });
  if (iconColor == null) {
    return undefined;
  }
  const supportedColor = TELEGRAM_FORUM_TOPIC_ICON_COLORS.find((color) => color === iconColor);
  if (supportedColor === undefined) {
    throw new Error("iconColor must be one of Telegram's supported forum topic colors.");
  }
  return supportedColor;
}

export function readTelegramChatId(params: Record<string, unknown>) {
  return (
    readStringOrNumberParam(params, "chatId") ??
    readStringOrNumberParam(params, "channelId") ??
    readStringOrNumberParam(params, "to", { required: true })
  );
}

export function readTelegramThreadId(params: Record<string, unknown>) {
  return (
    readPositiveIntegerParam(params, "messageThreadId", {
      message: "messageThreadId must be a positive integer.",
    }) ??
    readPositiveIntegerParam(params, "threadId", {
      message: "threadId must be a positive integer.",
    })
  );
}

export function readTelegramReplyToMessageId(params: Record<string, unknown>) {
  return (
    readPositiveIntegerParam(params, "replyToMessageId", {
      message: "replyToMessageId must be a positive integer.",
    }) ??
    readPositiveIntegerParam(params, "replyTo", {
      message: "replyTo must be a positive integer.",
    })
  );
}

function pushTelegramMediaUrl(mediaUrls: string[], seen: Set<string>, value: unknown): void {
  if (typeof value !== "string") {
    return;
  }
  const normalized = value.trim();
  if (!normalized || seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  mediaUrls.push(normalized);
}

export function readTelegramSendMediaUrls(params: Record<string, unknown>) {
  const mediaUrls: string[] = [];
  const seen = new Set<string>();
  pushTelegramMediaUrl(mediaUrls, seen, params.mediaUrl);
  pushTelegramMediaUrl(mediaUrls, seen, params.media);
  pushTelegramMediaUrl(mediaUrls, seen, params.path);
  pushTelegramMediaUrl(mediaUrls, seen, params.filePath);
  pushTelegramMediaUrl(mediaUrls, seen, params.fileUrl);
  if (Array.isArray(params.mediaUrls)) {
    for (const mediaUrl of params.mediaUrls) {
      pushTelegramMediaUrl(mediaUrls, seen, mediaUrl);
    }
  }
  if (Array.isArray(params.attachments)) {
    for (const attachment of params.attachments) {
      if (!isRecord(attachment)) {
        continue;
      }
      pushTelegramMediaUrl(mediaUrls, seen, attachment.media);
      pushTelegramMediaUrl(mediaUrls, seen, attachment.mediaUrl);
      pushTelegramMediaUrl(mediaUrls, seen, attachment.path);
      pushTelegramMediaUrl(mediaUrls, seen, attachment.filePath);
      pushTelegramMediaUrl(mediaUrls, seen, attachment.fileUrl);
      pushTelegramMediaUrl(mediaUrls, seen, attachment.url);
    }
  }
  return mediaUrls;
}
