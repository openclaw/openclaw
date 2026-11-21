import { buildTelegramGroupPeerId, type TelegramThreadSpec } from "./bot/helpers.js";

export function buildTelegramInboundDebounceKey(params: {
  accountId?: string | null;
  conversationKey: string;
  senderId: string;
}): string {
  return `telegram:${params.accountId?.trim() || "default"}:${params.conversationKey}:${params.senderId}`;
}

// Shared peer ids intentionally omit private DM topics so existing bindings keep
// the bare chat id. Debounce and cancellation still need one buffer per topic.
export function buildTelegramInboundDebounceConversationKey(params: {
  chatId: number | string;
  threadSpec: TelegramThreadSpec;
}): string {
  const chatId = String(params.chatId).trim();
  const id = params.threadSpec.id == null ? undefined : Math.trunc(params.threadSpec.id);
  if (chatId && params.threadSpec.scope === "dm" && id != null && Number.isFinite(id) && id > 0) {
    return `${chatId}:dm-topic:${id}`;
  }
  return buildTelegramGroupPeerId(params.chatId, params.threadSpec);
}
