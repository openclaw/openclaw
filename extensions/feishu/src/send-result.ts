// Feishu plugin module implements send result behavior.
import {
  createMessageReceiptFromOutboundResults,
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

export function createFeishuSendReceipt(params: {
  messageId?: string;
  chatId: string;
  kind?: MessageReceiptPartKind;
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
    ...(chatId ? { threadId: chatId } : {}),
    kind: params.kind ?? "unknown",
  });
}

/**
 * Feishu API error codes that mean the cached tenant_access_token is invalid
 * (expired, revoked, or clock-skewed). The cached SDK client keeps reusing the
 * stale token, so callers must drop the cached client and retry once instead of
 * failing every outgoing message until a manual gateway restart. (#97287)
 *
 * @see https://open.feishu.cn/document/server-docs/api-call-guide/generic-error-code
 */
const FEISHU_INVALID_TOKEN_CODES = new Set([99991663, 99991664]);

/**
 * Error thrown when a Feishu message API call returns a non-zero code. Carries
 * the numeric `.code` so recovery logic (e.g. invalid-token retry) can classify
 * the failure without parsing the human-readable message.
 */
export class FeishuMessageApiError extends Error {
  readonly code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.name = "FeishuMessageApiError";
    if (typeof code === "number") {
      this.code = code;
    }
  }
}

/**
 * Check whether an error represents an invalid tenant_access_token condition
 * (Feishu codes 99991663/99991664). Handles three shapes:
 * 1. FeishuMessageApiError / SDK error with a top-level numeric `.code`
 * 2. AxiosError with `response.data.code`
 * 3. Wrapped errors that carry the original under `.cause`
 */
export function isFeishuInvalidTokenError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) {
    return false;
  }
  const code = (err as { code?: number }).code;
  if (typeof code === "number" && FEISHU_INVALID_TOKEN_CODES.has(code)) {
    return true;
  }
  const response = (err as { response?: { data?: { code?: number } } }).response;
  if (
    typeof response?.data?.code === "number" &&
    FEISHU_INVALID_TOKEN_CODES.has(response.data.code)
  ) {
    return true;
  }
  const cause = (err as { cause?: unknown }).cause;
  if (cause && cause !== err) {
    return isFeishuInvalidTokenError(cause);
  }
  return false;
}

export function assertFeishuMessageApiSuccess(
  response: FeishuMessageApiResponse,
  errorPrefix: string,
) {
  if (response.code !== 0) {
    throw new FeishuMessageApiError(
      `${errorPrefix}: ${response.msg || `code ${response.code}`}`,
      response.code,
    );
  }
}

export function toFeishuSendResult(
  response: FeishuMessageApiResponse,
  chatId: string,
  kind?: MessageReceiptPartKind,
): {
  messageId: string;
  chatId: string;
  receipt: MessageReceipt;
} {
  const messageId = response.data?.message_id ?? "unknown";
  return {
    messageId,
    chatId,
    receipt: createFeishuSendReceipt({ messageId, chatId, kind }),
  };
}
