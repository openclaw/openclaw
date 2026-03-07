import { assertFeishuMessageApiSuccess, toFeishuSendResult } from "./send-result.js";

type FeishuMessageClient = {
  im: {
    message: {
      reply: (params: {
        path: { message_id: string };
        data: Record<string, unknown>;
      }) => Promise<{ code?: number; msg?: string; data?: { message_id?: string } }>;
      create: (params: {
        params: { receive_id_type: string };
        data: Record<string, unknown>;
      }) => Promise<{ code?: number; msg?: string; data?: { message_id?: string } }>;
    };
  };
};

export async function sendFeishuMessageWithOptionalReply(params: {
  client: FeishuMessageClient;
  receiveId: string;
  receiveIdType: string;
  content: string;
  msgType: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
  sendErrorPrefix: string;
  replyErrorPrefix: string;
  fallbackSendErrorPrefix?: string;
  shouldFallbackFromReply?: (response: { code?: number; msg?: string }) => boolean;
}): Promise<{ messageId: string; chatId: string }> {
  const data = {
    content: params.content,
    msg_type: params.msgType,
  };

  if (params.replyToMessageId) {
    const response = await params.client.im.message.reply({
      path: { message_id: params.replyToMessageId },
      data: {
        ...data,
        ...(params.replyInThread ? { reply_in_thread: true } : {}),
      },
    });
    if (params.shouldFallbackFromReply?.(response)) {
      const fallback = await params.client.im.message.create({
        params: { receive_id_type: params.receiveIdType },
        data: {
          receive_id: params.receiveId,
          ...data,
        },
      });
      assertFeishuMessageApiSuccess(
        fallback,
        params.fallbackSendErrorPrefix ?? params.sendErrorPrefix,
      );
      return toFeishuSendResult(fallback, params.receiveId);
    }
    assertFeishuMessageApiSuccess(response, params.replyErrorPrefix);
    return toFeishuSendResult(response, params.receiveId);
  }

  const response = await params.client.im.message.create({
    params: { receive_id_type: params.receiveIdType },
    data: {
      receive_id: params.receiveId,
      ...data,
    },
  });
  assertFeishuMessageApiSuccess(response, params.sendErrorPrefix);
  return toFeishuSendResult(response, params.receiveId);
}
