import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import {
  createMessageReceiptFromOutboundResults,
  type ChannelMessageSendResult,
  type MessageReceipt,
  type MessageReceiptPartKind,
} from "openclaw/plugin-sdk/channel-outbound";

type FeishuMessageApiResponse = {
  code?: number;
  msg?: string;
  data?: {
    message_id?: string;
  };
};

export function resolveFeishuReceiptKind(msgType?: string): MessageReceiptPartKind {
  switch (msgType) {
    case "audio":
      return "voice";
    case "image":
    case "media":
    case "file":
    case "sticker":
      return "media";
    case "interactive":
      return "card";
    case "post":
    case "text":
      return "text";
    default:
      return "unknown";
  }
}

function createFeishuSendReceipt(params: {
  messageId?: string;
  chatId: string;
  kind?: MessageReceiptPartKind;
  replyToId?: string;
}): MessageReceipt {
  const messageId = params.messageId?.trim();
  const chatId = params.chatId.trim();
  return createMessageReceiptFromOutboundResults({
    results: messageId
      ? [
          {
            channel: "feishu",
            messageId,
            chatId,
            conversationId: chatId,
          },
        ]
      : [],
    ...(params.replyToId?.trim() ? { replyToId: params.replyToId.trim() } : {}),
    kind: params.kind ?? "unknown",
  });
}

export function toFeishuSendResult(
  response: FeishuMessageApiResponse,
  chatId: string,
  kind?: MessageReceiptPartKind,
  errorPrefix = "Feishu send failed",
  replyToId?: string,
): {
  messageId: string;
  chatId: string;
  receipt: MessageReceipt;
} {
  const messageId = response.data?.message_id?.trim();
  if (!messageId) {
    // Feishu already accepted this send; an ordinary error would invite a duplicate retry.
    throw createChannelPartialDeliveryError(new Error(`${errorPrefix}: no message_id returned`), {
      messageIds: [],
      visibleReplySent: true,
    });
  }
  return {
    messageId,
    chatId,
    receipt: createFeishuSendReceipt({ messageId, chatId, kind, replyToId }),
  };
}

export function toFeishuMessageSendResult(
  result: { messageId?: string; chatId?: string; receipt?: ChannelMessageSendResult["receipt"] },
  kind: MessageReceiptPartKind,
): ChannelMessageSendResult {
  const receipt =
    result.receipt ??
    createFeishuSendReceipt({
      messageId: result.messageId,
      chatId: result.chatId ?? "",
      kind,
    });
  return {
    messageId: result.messageId || receipt.primaryPlatformMessageId,
    receipt,
  };
}
