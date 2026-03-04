export type FeishuMessageApiResponse = {
  code?: number;
  msg?: string;
  data?: {
    message_id?: string;
  };
};

/**
 * Error code for "open_id cross app" - happens when the open_id in session
 * belongs to a different Feishu app (e.g., after app_id/app_secret change)
 */
export const FEISHU_OPEN_ID_CROSS_APP_ERROR_CODE = 99992361;

/**
 * Check if the error is an "open_id cross app" error
 * This happens when session contains an open_id from a different Feishu app
 */
export function isOpenIdCrossAppError(response: FeishuMessageApiResponse): boolean {
  return response.code === FEISHU_OPEN_ID_CROSS_APP_ERROR_CODE;
}

export class FeishuOpenIdCrossAppError extends Error {
  public readonly code: number;
  public readonly originalMsg: string;

  constructor(msg: string, code: number) {
    super(`Feishu open_id cross app error: ${msg} (code: ${code})`);
    this.code = code;
    this.originalMsg = msg;
  }
}

export function assertFeishuMessageApiSuccess(
  response: FeishuMessageApiResponse,
  errorPrefix: string,
) {
  if (response.code !== 0) {
    // Throw specific error for open_id cross app to allow session reset
    if (isOpenIdCrossAppError(response)) {
      throw new FeishuOpenIdCrossAppError(
        response.msg || "open_id cross app",
        response.code!, // Non-null assertion since we checked the code
      );
    }
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
