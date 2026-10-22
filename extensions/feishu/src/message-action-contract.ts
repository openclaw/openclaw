import type { ChannelMessageActionAdapter } from "openclaw/plugin-sdk/channel-contract";

const FEISHU_NATIVE_CHAT_TARGET_ALIASES = ["chatId", "chat_id", "channel_id"];

// The shared cross-context guard needs every native destination consumed by resolveFeishuChatId.
const messageMutationTargetAliases = {
  aliases: ["messageId", ...FEISHU_NATIVE_CHAT_TARGET_ALIASES],
  deliveryTargetAliases: FEISHU_NATIVE_CHAT_TARGET_ALIASES,
};

export const messageActionTargetAliases = {
  read: { aliases: ["messageId"] },
  edit: messageMutationTargetAliases,
  pin: messageMutationTargetAliases,
  unpin: messageMutationTargetAliases,
  "list-pins": { aliases: ["chatId"] },
  "channel-info": { aliases: ["chatId"] },
} satisfies NonNullable<ChannelMessageActionAdapter["messageActionTargetAliases"]>;
