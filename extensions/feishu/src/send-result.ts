export type FeishuMessageApiResponse = {
  code?: number;
  msg?: string;
  data?: {
    message_id?: string;
    thread_id?: string;
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
): {
  messageId: string;
  chatId: string;
  nativeThreadId?: string;
} {
  return {
    messageId: response.data?.message_id ?? "unknown",
    chatId,
    nativeThreadId:
      typeof response.data?.thread_id === "string" && response.data.thread_id.trim()
        ? response.data.thread_id.trim()
        : undefined,
  };
}
