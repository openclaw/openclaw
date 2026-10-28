import type { ChannelMessageActionName } from "openclaw/plugin-sdk/channel-contract";

export const TELEGRAM_MESSAGE_ACTION_MAP = {
  delete: "deleteMessage",
  edit: "editMessage",
  "emoji-list": "emoji-list",
  poll: "poll",
  react: "react",
  read: "read",
  send: "sendMessage",
  sticker: "sendSticker",
  "sticker-search": "searchSticker",
  "topic-create": "createForumTopic",
  "topic-edit": "editForumTopic",
} as const satisfies Partial<Record<ChannelMessageActionName, string>>;

const TELEGRAM_ACTION_ALIASES = {
  ...TELEGRAM_MESSAGE_ACTION_MAP,
  createForumTopic: "createForumTopic",
  deleteMessage: "deleteMessage",
  editForumTopic: "editForumTopic",
  editMessage: "editMessage",
  searchSticker: "searchSticker",
  sendMessage: "sendMessage",
  sendSticker: "sendSticker",
  stickerCacheStats: "stickerCacheStats",
} as const;

type TelegramActionName = (typeof TELEGRAM_ACTION_ALIASES)[keyof typeof TELEGRAM_ACTION_ALIASES];

export function normalizeTelegramActionName(action: string): TelegramActionName {
  const normalized = Object.entries(TELEGRAM_ACTION_ALIASES).find(
    ([alias]) => alias === action,
  )?.[1];
  if (!normalized) {
    throw new Error(`Unsupported Telegram action: ${action}`);
  }
  return normalized;
}
