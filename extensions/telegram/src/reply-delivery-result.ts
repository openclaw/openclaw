export type TelegramReplyDeliveryResult = {
  visibleReplySent: boolean;
  messageId?: string;
  content?: string;
};

export const noVisibleReplyDelivery: TelegramReplyDeliveryResult = {
  visibleReplySent: false,
};

export function replyDeliveryResult(
  visibleReplySent: boolean,
  messageId?: string | number,
  content?: string,
): TelegramReplyDeliveryResult {
  return {
    visibleReplySent,
    ...(messageId ? { messageId: String(messageId) } : {}),
    ...(content === undefined ? {} : { content }),
  };
}
