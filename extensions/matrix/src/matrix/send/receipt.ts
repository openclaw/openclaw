import {
  createMessageReceiptFromOutboundResults,
  type MessageReceiptPartKind,
} from "openclaw/plugin-sdk/channel-outbound";

export type MatrixReceiptEvent = {
  messageId: string;
  kind: MessageReceiptPartKind;
  replyToId?: string;
};

export function createMatrixSendReceipt(params: {
  roomId: string;
  events: readonly MatrixReceiptEvent[];
  threadId?: string | null;
}) {
  const firstEvent = params.events[0];
  const receipt = createMessageReceiptFromOutboundResults({
    kind: firstEvent?.kind ?? "text",
    ...(firstEvent?.replyToId ? { replyToId: firstEvent.replyToId } : {}),
    ...(params.threadId ? { threadId: params.threadId } : {}),
    results: params.events.map(({ messageId }) => ({
      channel: "matrix",
      messageId,
      roomId: params.roomId,
    })),
  });
  // Caption overflow is not a native reply; never copy the first event's relation onto later parts.
  receipt.parts = receipt.parts.map((part, index) => {
    const event = params.events[index]!;
    const actualPart = { ...part, kind: event.kind };
    if (event.replyToId) {
      actualPart.replyToId = event.replyToId;
    } else {
      delete actualPart.replyToId;
    }
    return actualPart;
  });
  return receipt;
}
