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
    const errorMsg = response.msg || `code ${response.code}`;
    // If errorPrefix already contains Chinese brackets, don't add extra prefix
    if (errorPrefix.startsWith("[") && errorPrefix.includes("]")) {
      throw new Error(`${errorPrefix}: ${errorMsg}`);
    }
    throw new Error(`${errorPrefix}: ${errorMsg}`);
  }
}

export function toFeishuSendResult(
  response: FeishuMessageApiResponse,
  chatId: string,
): {
  messageId: string;
  chatId: string;
} {
  return {
    messageId: response.data?.message_id ?? "unknown",
    chatId,
  };
}
