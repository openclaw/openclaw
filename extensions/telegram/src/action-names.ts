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
