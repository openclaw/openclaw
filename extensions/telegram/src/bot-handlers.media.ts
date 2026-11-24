import type { Message } from "grammy/types";
import { MediaFetchError } from "openclaw/plugin-sdk/media-runtime";

const TELEGRAM_BOT_API_FILE_DOWNLOAD_LIMIT_MB = 20;

export class TelegramBotApiFileTooLargeError extends MediaFetchError {
  readonly limitMb = TELEGRAM_BOT_API_FILE_DOWNLOAD_LIMIT_MB;

  constructor(cause: unknown) {
    super(
      "max_bytes",
      `Telegram Bot API cannot download files larger than ${TELEGRAM_BOT_API_FILE_DOWNLOAD_LIMIT_MB} MB`,
      { cause, status: 400 },
    );
    this.name = "TelegramBotApiFileTooLargeError";
  }
}

export function isMediaSizeLimitError(err: unknown): boolean {
  if (err instanceof MediaFetchError) {
    return err.code === "max_bytes";
  }
  const errMsg = String(err);
  return errMsg.includes("exceeds") && errMsg.includes("MB limit");
}

export function hasInboundMedia(msg: Message): boolean {
  return (
    Boolean(msg.media_group_id) ||
    (Array.isArray(msg.photo) && msg.photo.length > 0) ||
    Boolean(
      msg.video ??
      msg.video_note ??
      msg.animation ??
      msg.document ??
      msg.audio ??
      msg.voice ??
      msg.sticker,
    )
  );
}
