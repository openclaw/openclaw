export const TELEGRAM_MAX_CAPTION_LENGTH = 1024;

export function splitTelegramCaption(text?: string): {
  caption?: string;
  followUpText?: string;
} {
  const trimmed = text?.trim() ?? "";
  if (!trimmed) {
    return { caption: undefined, followUpText: undefined };
  }
  if (trimmed.length > TELEGRAM_MAX_CAPTION_LENGTH) {
    return { caption: undefined, followUpText: trimmed };
  }
  return { caption: trimmed, followUpText: undefined };
}

export function splitTelegramRenderedCaption(
  text: string | undefined,
  renderCaption: (caption: string) => string,
): {
  caption?: string;
  renderedCaption?: string;
  followUpText?: string;
} {
  const split = splitTelegramCaption(text);
  if (!split.caption) {
    return split;
  }
  const renderedCaption = renderCaption(split.caption);
  if (renderedCaption.length > TELEGRAM_MAX_CAPTION_LENGTH) {
    return {
      caption: undefined,
      renderedCaption: undefined,
      followUpText: split.caption,
    };
  }
  return { caption: split.caption, renderedCaption, followUpText: undefined };
}
