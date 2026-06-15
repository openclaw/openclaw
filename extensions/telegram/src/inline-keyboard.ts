// Telegram plugin module implements inline keyboard behavior.
import type { InlineKeyboardButton, InlineKeyboardMarkup } from "grammy/types";
import type { TelegramInlineButtons } from "./button-types.js";

export type TelegramInlineKeyboardChatType = "direct" | "group" | "unknown";

function toInlineKeyboardButton(
  button: TelegramInlineButtons[number][number] | undefined,
  chatType: TelegramInlineKeyboardChatType,
): InlineKeyboardButton | undefined {
  if (!button?.text) {
    return undefined;
  }
  if (button.url) {
    return button.style
      ? { text: button.text, url: button.url, style: button.style }
      : { text: button.text, url: button.url };
  }
  if (button.callback_data) {
    return button.style
      ? { text: button.text, callback_data: button.callback_data, style: button.style }
      : { text: button.text, callback_data: button.callback_data };
  }
  if (button.web_app?.url) {
    if (chatType === "group") {
      return button.style
        ? { text: button.text, url: button.web_app.url, style: button.style }
        : { text: button.text, url: button.web_app.url };
    }
    return button.style
      ? { text: button.text, web_app: { url: button.web_app.url }, style: button.style }
      : { text: button.text, web_app: { url: button.web_app.url } };
  }
  return undefined;
}

export function buildInlineKeyboard(
  buttons?: TelegramInlineButtons,
  options?: { chatType?: TelegramInlineKeyboardChatType },
): InlineKeyboardMarkup | undefined {
  if (!buttons?.length) {
    return undefined;
  }
  const chatType = options?.chatType ?? "unknown";
  const rows = buttons
    .map((row) =>
      row
        .map((button) => toInlineKeyboardButton(button, chatType))
        .filter((button): button is InlineKeyboardButton => Boolean(button)),
    )
    .filter((row) => row.length > 0);
  if (rows.length === 0) {
    return undefined;
  }
  return { inline_keyboard: rows };
}
