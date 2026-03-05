export type FeishuMessageApiResponse = {
  code?: number;
  msg?: string;
  data?: {
    message_id?: string;
  };
};

export type FeishuMessageApiErrorContext = {
  receiveIdType?: string;
};

const CROSS_APP_HINT =
  "open_id belongs to a different Feishu app/account; route using the account that owns this open_id";

function looksLikeCrossAppOpenIdError(params: {
  response: FeishuMessageApiResponse;
  context?: FeishuMessageApiErrorContext;
}): boolean {
  const msg = params.response.msg?.toLowerCase() ?? "";
  if (!msg) {
    return false;
  }

  if (/cross[\s-]?app|different app|跨应用|跨\s*app/i.test(msg)) {
    return true;
  }

  const receiveIdType = params.context?.receiveIdType?.toLowerCase();
  const isOpenIdTarget = receiveIdType === "open_id";
  if (isOpenIdTarget && /invalid\s+user_?id/i.test(msg)) {
    return true;
  }

  return false;
}

export function assertFeishuMessageApiSuccess(
  response: FeishuMessageApiResponse,
  errorPrefix: string,
  context?: FeishuMessageApiErrorContext,
) {
  if (response.code !== 0) {
    const detail = response.msg || `code ${response.code}`;
    const hint = looksLikeCrossAppOpenIdError({ response, context }) ? `; ${CROSS_APP_HINT}` : "";
    throw new Error(`${errorPrefix}: ${detail}${hint}`);
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
