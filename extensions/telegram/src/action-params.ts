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
const SEND_MEDIA_FIELDS = ["mediaUrl", "media", "path", "filePath", "fileUrl"];
const ATTACHMENT_MEDIA_FIELDS = ["media", "mediaUrl", "path", "filePath", "fileUrl", "url"];

export function readTelegramPositiveIntegerParam(params: Record<string, unknown>, key: string) {
  return readPositiveIntegerParam(params, key, { message: `${key} must be a positive integer.` });
}

export function readTelegramForumTopicIconColor(
  params: Record<string, unknown>,
): TelegramForumTopicIconColor | undefined {
  const iconColor = readPositiveIntegerParam(params, "iconColor", {
    message: "iconColor must be one of Telegram's supported forum topic colors.",
  });
  const supportedColor = TELEGRAM_FORUM_TOPIC_ICON_COLORS.find((color) => color === iconColor);
  if (iconColor != null && supportedColor === undefined) {
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
    readTelegramPositiveIntegerParam(params, "messageThreadId") ??
    readTelegramPositiveIntegerParam(params, "threadId")
  );
}

export function readTelegramReplyToMessageId(params: Record<string, unknown>) {
  return (
    readTelegramPositiveIntegerParam(params, "replyToMessageId") ??
    readTelegramPositiveIntegerParam(params, "replyTo")
  );
}

export function readTelegramSendMediaUrls(params: Record<string, unknown>) {
  const attachments = Array.isArray(params.attachments) ? params.attachments.filter(isRecord) : [];
  return normalizeUniqueTrimmedStringList([
    ...SEND_MEDIA_FIELDS.map((field) => params[field]),
    ...(Array.isArray(params.mediaUrls) ? params.mediaUrls : []),
    ...attachments.flatMap((attachment) =>
      ATTACHMENT_MEDIA_FIELDS.map((field) => attachment[field]),
    ),
  ]);
}
