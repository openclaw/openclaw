import {
  createMessageReceiptFromOutboundResults,
  type MessageReceiptPartKind,
} from "openclaw/plugin-sdk/channel-outbound";

export function createMatrixSendReceipt(params: {
  roomId: string;
  platformMessageIds: readonly string[];
  kind: MessageReceiptPartKind;
  replyToId?: string;
  threadId?: string | null;
}) {
  return createMessageReceiptFromOutboundResults({
    kind: params.kind,
    ...(params.replyToId ? { replyToId: params.replyToId } : {}),
    ...(params.threadId ? { threadId: params.threadId } : {}),
    results: params.platformMessageIds.map((messageId) => ({
      channel: "matrix",
      messageId,
      roomId: params.roomId,
    })),
  });
}
