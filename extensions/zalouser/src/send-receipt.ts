import {
  createMessageReceiptFromOutboundResults,
  type MessageReceipt,
  type MessageReceiptPartKind,
} from "openclaw/plugin-sdk/channel-outbound";

export function createZalouserSendReceipt(params: {
  messageId?: string;
  platformMessageIds?: readonly (string | null | undefined)[];
  threadId?: string;
  kind?: MessageReceiptPartKind;
}): MessageReceipt {
  const platformMessageIds = (params.platformMessageIds ?? [params.messageId])
    .map((messageId) => messageId?.trim())
    .filter((messageId): messageId is string => Boolean(messageId));
  const threadId = params.threadId?.trim();
  return createMessageReceiptFromOutboundResults({
    results: platformMessageIds.map((messageId) =>
      threadId
        ? { channel: "zalouser", messageId, conversationId: threadId }
        : { channel: "zalouser", messageId },
    ),
    ...(threadId ? { threadId } : {}),
    kind: params.kind ?? "unknown",
  });
}
