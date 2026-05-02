import type { InlineKeyboardButton, InlineKeyboardMarkup } from "@grammyjs/types";
import type { TelegramInlineButtons } from "./button-types.js";

export function buildInlineKeyboard(
  buttons?: TelegramInlineButtons,
): InlineKeyboardMarkup | undefined {
  if (!buttons?.length) {
    return undefined;
  }
  const rows = buttons
    .map((row) =>
      row.flatMap((button): InlineKeyboardButton[] => {
        if (!button?.text) {
          return [];
        }
        if (button.url) {
          return [
            Object.assign(
              { text: button.text, url: button.url },
              button.style ? { style: button.style } : {},
            ),
          ];
        }
        if (button.callback_data) {
          return [
            Object.assign(
              { text: button.text, callback_data: button.callback_data },
              button.style ? { style: button.style } : {},
            ),
          ];
        }
        return [];
      }),
    )
    .filter((row) => row.length > 0);
  if (rows.length === 0) {
    return undefined;
  }
  return { inline_keyboard: rows };
}
