export function buildTelegramInboundDebounceKey(params: {
  accountId?: string | null;
  conversationKey: string;
  senderId: string;
}): string {
  return `telegram:${params.accountId?.trim() || "default"}:${params.conversationKey}:${params.senderId}`;
}
