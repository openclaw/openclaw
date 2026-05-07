import type { InlineKeyboardMarkup } from "@grammyjs/types";
import { InlineKeyboard } from "grammy";
import type { TelegramInlineButtons } from "./button-types.js";

export function buildInlineKeyboard(
  buttons?: TelegramInlineButtons,
): InlineKeyboardMarkup | undefined {
  const rows = (buttons ?? [])
    .map((row) =>
      row
        .filter((button) => button.text && button.callback_data)
        .map((button) =>
          InlineKeyboard.text(
            button.style ? { text: button.text, style: button.style } : button.text,
            button.callback_data,
          ),
        ),
    )
    .filter((row) => row.length > 0);
  return rows.length > 0 ? { inline_keyboard: rows } : undefined;
}
