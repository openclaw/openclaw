// Telegram plugin module implements legacy silent marker parsing.

const TRAILING_NOTIFY_FALSE_RE = /(?:^|\r?\n)[ \t]*notify=false[ \t]*(?:\r?\n[ \t]*)*$/i;

export function consumeTelegramSilentNotificationMarker(
  text: string,
  silent?: boolean,
): { text: string; silent?: boolean; consumed: boolean } {
  const match = TRAILING_NOTIFY_FALSE_RE.exec(text);
  if (!match) {
    return { text, silent, consumed: false };
  }
  return {
    text: text.slice(0, match.index).trimEnd(),
    silent: true,
    consumed: true,
  };
}
