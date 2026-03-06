export type FeishuMessageApiResponse = {
  code?: number;
  msg?: string;
  data?: {
    message_id?: string;
    chat_id?: string;
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

export function rethrowWithFeishuErrorDetail(err: unknown, prefix: string): never {
  const data = (err as any)?.response?.data;
  if (data && typeof data.msg === "string") {
    throw new Error(`${prefix}: ${data.msg}`, { cause: err });
  }
  throw err;
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
    // Prefer API-returned chat_id over the caller-provided fallback.
    // For DMs sent via open_id, the caller passes the user's open_id as chatId,
    // but the API response contains the actual oc_* conversation chat_id.
    chatId: response.data?.chat_id ?? chatId,
  };
}
