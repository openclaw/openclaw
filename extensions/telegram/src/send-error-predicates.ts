import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

function resolveTelegramErrorDescription(error: unknown): string {
  return isRecord(error) && typeof error.description === "string"
    ? error.description
    : formatErrorMessage(error);
}

export function isTelegramCaptionTooLongError(error: unknown): boolean {
  return /caption is too long/i.test(resolveTelegramErrorDescription(error));
}

export function isTelegramPhotoLimitError(error: unknown): boolean {
  return /\b(?:PHOTO_INVALID_DIMENSIONS|PHOTO_TOO_BIG)\b/i.test(
    resolveTelegramErrorDescription(error),
  );
}

export function isTelegramVoiceMessagesForbiddenError(error: unknown): boolean {
  return resolveTelegramErrorDescription(error).includes("VOICE_MESSAGES_FORBIDDEN");
}
