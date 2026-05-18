import type { ChannelMessageActionName } from "openclaw/plugin-sdk/channel-contract";

type MessageActionTargetAliasSpec = {
  aliases: string[];
};

export const messageActionTargetAliases = {
  delete: { aliases: ["messageId"] },
  unsend: { aliases: ["messageId"] },
  read: { aliases: ["messageId"] },
  "thread-reply": { aliases: ["messageId"] },
  "thread-create": { aliases: ["messageId"] },
  pin: { aliases: ["messageId"] },
  unpin: { aliases: ["messageId"] },
  "list-pins": { aliases: ["chatId"] },
  "channel-info": { aliases: ["chatId"] },
} satisfies Partial<Record<ChannelMessageActionName, MessageActionTargetAliasSpec>>;
