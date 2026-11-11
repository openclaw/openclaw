import type { InlineKeyboardButton, InlineKeyboardMarkup } from "grammy/types";
import type { TelegramInlineButtons } from "./button-types.js";

export function buildInlineKeyboard(
  buttons?: TelegramInlineButtons,
): InlineKeyboardMarkup | undefined {
  if (!buttons?.length) {
    return undefined;
  }
  const rows = buttons
    .map((row) =>
      row
        .map((button): InlineKeyboardButton | undefined => {
          if (!button?.text) {
            return undefined;
          }
          const label = { text: button.text, ...(button.style ? { style: button.style } : {}) };
          if (button.url) {
            return { ...label, url: button.url };
          }
          if (button.callback_data) {
            return { ...label, callback_data: button.callback_data };
          }
          if (button.web_app?.url) {
            return { ...label, web_app: { url: button.web_app.url } };
          }
          return undefined;
        })
        .filter((button): button is InlineKeyboardButton => Boolean(button)),
    )
    .filter((row) => row.length > 0);
  return rows.length > 0 ? { inline_keyboard: rows } : undefined;
}
