import {
  readPositiveIntegerParam,
  readStringOrNumberParam,
} from "openclaw/plugin-sdk/channel-actions";
import {
  isRecord,
  normalizeUniqueTrimmedStringList,
} from "openclaw/plugin-sdk/string-coerce-runtime";

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

export function readTelegramSendMediaUrls(params: Record<string, unknown>) {
  const attachments = Array.isArray(params.attachments) ? params.attachments.filter(isRecord) : [];
  return normalizeUniqueTrimmedStringList([
    params.mediaUrl,
    params.media,
    params.path,
    params.filePath,
    params.fileUrl,
    ...(Array.isArray(params.mediaUrls) ? params.mediaUrls : []),
    ...attachments.flatMap((attachment) => [
      attachment.media,
      attachment.mediaUrl,
      attachment.path,
      attachment.filePath,
      attachment.fileUrl,
      attachment.url,
    ]),
  ]);
}
