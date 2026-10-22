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
  const { messageIds, chatId } = params;
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
