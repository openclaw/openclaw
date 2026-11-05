import type { Message } from "grammy/types";
import { MediaFetchError } from "openclaw/plugin-sdk/media-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { isRecoverableTelegramNetworkError } from "./network-errors.js";

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

export function isRecoverableMediaGroupError(err: unknown): boolean {
  return err instanceof MediaFetchError || isMediaSizeLimitError(err);
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  if ("name" in err && err.name === "AbortError") {
    return true;
  }
  return "message" in err && err.message === "This operation was aborted";
}

export function isDurablyRetryableInboundMediaError(err: unknown): boolean {
  if (!(err instanceof MediaFetchError)) {
    return false;
  }
  return err.code === "http_error"
    ? typeof err.status === "number" &&
        (err.status === 408 || err.status === 429 || err.status >= 500)
    : err.code === "fetch_failed" &&
        (isAbortError(err) || isAbortError(err.cause) || isRecoverableTelegramNetworkError(err));
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

// The Telegram handler logger is file-only in Gateway deployments, so a media
// failure reported only through it never reached container stdout (#193172).
// This subsystem logger writes to the file log and the console sink, and the
// errno it carries tells an operator which step of the save failed.
const mediaFailureLog = createSubsystemLogger("telegram/media");

/** Follow the cause chain: media errors wrap the filesystem failure that names the errno. */
export function resolveMediaFailureCode(err: unknown): string | undefined {
  let current: unknown = err;
  let deepest: string | undefined;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object") {
      return deepest;
    }
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) {
      deepest = code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return deepest;
}

/** Record an inbound media failure where an operator can see it. */
export function logInboundMediaFailure(params: {
  message: string;
  accountId: string;
  chatId: number | string;
  error: unknown;
}): void {
  const code = resolveMediaFailureCode(params.error);
  mediaFailureLog.warn(params.message, {
    accountId: params.accountId,
    chatId: params.chatId,
    error: String(params.error),
    ...(code ? { code } : {}),
  });
}
