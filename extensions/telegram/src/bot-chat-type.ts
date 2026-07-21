import type { InboundChatType } from "openclaw/plugin-sdk";

export function normalizeTelegramInboundChatType(chatType: string): InboundChatType | undefined {
  switch (chatType) {
    case "private":
      return "direct";
    case "group":
    case "supergroup":
    case "channel":
      return chatType;
    default:
      return undefined;
  }
}
