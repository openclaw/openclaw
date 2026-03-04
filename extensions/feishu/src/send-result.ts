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
): {
  messageId: string;
  chatId: string;
} {
  return {
    messageId: response.data?.message_id ?? "unknown",
    chatId,
  };
}

/** Feishu API error code: open_id belongs to a different app */
export const FEISHU_CROSS_APP_ERROR_CODE = 99992361;

/**
 * Check if a Feishu API error is an "open_id cross app" error.
 * This happens when session stores an open_id from a previous app configuration.
 */
export function isCrossAppError(error: unknown): boolean {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code: number }).code === FEISHU_CROSS_APP_ERROR_CODE
  ) {
    return true;
  }

  if (error instanceof Error) {
    const msg = error.message ?? "";
    if (msg.includes("cross app") || msg.includes("99992361")) {
      return true;
    }
  }

  if (error && typeof error === "object" && "response" in error) {
    const resp = (error as { response?: { data?: { code?: number } } }).response;
    if (resp?.data?.code === FEISHU_CROSS_APP_ERROR_CODE) {
      return true;
    }
  }

  return false;
}
