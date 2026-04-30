import type { InlineKeyboardButton, InlineKeyboardMarkup } from "@grammyjs/types";
import type { TelegramInlineButtons } from "./button-types.js";

function isInlineKeyboardButton(
  value: InlineKeyboardButton | undefined,
): value is InlineKeyboardButton {
  return value !== undefined;
}

function buildInlineKeyboardButton(
  button: TelegramInlineButtons[number][number],
): InlineKeyboardButton | undefined {
  if (!button?.text) {
    return undefined;
  }
  const base = Object.assign({ text: button.text }, button.style ? { style: button.style } : {});
  if ("callback_data" in button && button.callback_data) {
    return { ...base, callback_data: button.callback_data };
  }
  if ("web_app" in button && button.web_app.url) {
    return { ...base, web_app: { url: button.web_app.url } };
  }
  if ("url" in button && button.url) {
    return { ...base, url: button.url };
  }
  return undefined;
}

export function buildInlineKeyboard(
  buttons?: TelegramInlineButtons,
): InlineKeyboardMarkup | undefined {
  if (!buttons?.length) {
    return undefined;
  }
  const rows = buttons
    .map((row) =>
      row.map((button) => buildInlineKeyboardButton(button)).filter(isInlineKeyboardButton),
    )
    .filter((row) => row.length > 0);
  if (rows.length === 0) {
    return undefined;
  }
  return { inline_keyboard: rows };
}
