export type FeishuMessageApiResponse = {
  code?: number;
  msg?: string;
  data?: {
    message_id?: string;
  };
};

export function assertFeishuMessageApiSuccess(
  response: FeishuMessageApiResponse,
  errorPrefix: string,
) {
  if (response.code !== 0) {
    throw new Error(`${errorPrefix}: ${response.msg || `code ${response.code}`}`);
  }
}

export function toFeishuSendResult(
  response: FeishuMessageApiResponse,
  chatId: string,
  viaReplyPath = true,
): {
  messageId: string;
  chatId: string;
  viaReplyPath: boolean;
} {
  return {
    messageId: response.data?.message_id ?? "unknown",
    chatId,
    viaReplyPath,
  };
}
