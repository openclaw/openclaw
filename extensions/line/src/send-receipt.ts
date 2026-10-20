import {
  createMessageReceiptFromOutboundResults,
  type MessageReceipt,
  type MessageReceiptPartKind,
} from "openclaw/plugin-sdk/channel-outbound";

export function createLineSendReceipt(params: {
  messageIds: readonly string[];
  chatId: string;
  kind?: MessageReceiptPartKind;
  messageCount?: number;
}): MessageReceipt {
  const messageIds = params.messageIds.map((messageId) => messageId.trim()).filter(Boolean);
  const chatId = params.chatId.trim();
  return createMessageReceiptFromOutboundResults({
    results: messageIds.map((messageId) => ({
      channel: "line",
      messageId,
      chatId,
      conversationId: chatId,
      meta: {
        messageCount: params.messageCount ?? 1,
      },
    })),
    ...(chatId ? { threadId: chatId } : {}),
    kind: params.kind ?? "unknown",
  });
}
