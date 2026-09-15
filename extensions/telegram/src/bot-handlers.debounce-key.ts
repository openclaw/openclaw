import { buildTelegramGroupPeerId, type TelegramThreadSpec } from "./bot/helpers.js";
export function buildTelegramInboundDebounceKey(params: {
  accountId?: string | null;
  conversationKey: string;
  senderId: string;
  debounceLane: "default" | "forward";
}): string {
  const resolvedAccountId = params.accountId?.trim() || "default";
  return `telegram:${resolvedAccountId}:${params.conversationKey}:${params.senderId}:${params.debounceLane}`;
}

export function buildTelegramInboundDebounceConversationKey(params: {
  chatId: number | string;
  threadSpec: TelegramThreadSpec;
}): string {
  const { chatId, threadSpec } = params;
  // Group peer IDs omit private topics; buffers and cancellation must retain them.
  return threadSpec.scope === "dm" && threadSpec.id != null
    ? `${chatId}:dm-topic:${threadSpec.id}`
    : buildTelegramGroupPeerId(chatId, threadSpec);
}
