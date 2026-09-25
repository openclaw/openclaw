import { buildTelegramGroupPeerId, type TelegramThreadSpec } from "./bot/helpers.js";
export function buildTelegramInboundDebounceKey(params: {
  accountId?: string | null;
  conversationKey: string;
  senderId: string;
}): string {
  const resolvedAccountId = params.accountId?.trim() || "default";
  return `telegram:${resolvedAccountId}:${params.conversationKey}:${params.senderId}`;
}

export function buildTelegramInboundDebounceConversationKey(params: {
  chatId: number | string;
  threadSpec: TelegramThreadSpec;
}): string {
  return buildTelegramGroupPeerId(params.chatId, params.threadSpec);
}
