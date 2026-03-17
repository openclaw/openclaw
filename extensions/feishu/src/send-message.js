import { assertFeishuMessageApiSuccess, toFeishuSendResult } from "./send-result.js";
async function sendFeishuMessageWithOptionalReply(params) {
  const data = {
    content: params.content,
    msg_type: params.msgType
  };
  if (params.replyToMessageId) {
    const response2 = await params.client.im.message.reply({
      path: { message_id: params.replyToMessageId },
      data: {
        ...data,
        ...params.replyInThread ? { reply_in_thread: true } : {}
      }
    });
    if (params.shouldFallbackFromReply?.(response2)) {
      const fallback = await params.client.im.message.create({
        params: { receive_id_type: params.receiveIdType },
        data: {
          receive_id: params.receiveId,
          ...data
        }
      });
      assertFeishuMessageApiSuccess(
        fallback,
        params.fallbackSendErrorPrefix ?? params.sendErrorPrefix
      );
      return toFeishuSendResult(fallback, params.receiveId);
    }
    assertFeishuMessageApiSuccess(response2, params.replyErrorPrefix);
    return toFeishuSendResult(response2, params.receiveId);
  }
  const response = await params.client.im.message.create({
    params: { receive_id_type: params.receiveIdType },
    data: {
      receive_id: params.receiveId,
      ...data
    }
  });
  assertFeishuMessageApiSuccess(response, params.sendErrorPrefix);
  return toFeishuSendResult(response, params.receiveId);
}
export {
  sendFeishuMessageWithOptionalReply
};
