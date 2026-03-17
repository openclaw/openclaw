const TELEGRAM_MAX_CAPTION_LENGTH = 1024;
function splitTelegramCaption(text) {
  const trimmed = text?.trim() ?? "";
  if (!trimmed) {
    return { caption: void 0, followUpText: void 0 };
  }
  if (trimmed.length > TELEGRAM_MAX_CAPTION_LENGTH) {
    return { caption: void 0, followUpText: trimmed };
  }
  return { caption: trimmed, followUpText: void 0 };
}
export {
  TELEGRAM_MAX_CAPTION_LENGTH,
  splitTelegramCaption
};
