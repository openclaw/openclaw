import type * as Lark from "@larksuiteoapi/node-sdk";

/**
 * Urgency type for Feishu urgent messages.
 * - "app": In-app buzz notification (default, no extra cost)
 * - "sms": SMS push to the recipient's phone
 * - "phone": Voice call to the recipient's phone
 */
export type FeishuUrgentType = "app" | "sms" | "phone";

type UrgentPayload = {
  data: { user_id_list: string[] };
  params: { user_id_type: "open_id" | "user_id" | "union_id" };
  path: { message_id: string };
};

type UrgentResponse = {
  code?: number;
  msg?: string;
  data?: { invalid_user_id_list?: string[] };
};

type LarkMessageWithUrgent = Lark.Client["im"]["message"] & {
  urgentApp?: (payload: UrgentPayload) => Promise<UrgentResponse>;
  urgentSms?: (payload: UrgentPayload) => Promise<UrgentResponse>;
  urgentPhone?: (payload: UrgentPayload) => Promise<UrgentResponse>;
};

/**
 * Extract a human-readable error message from a Feishu API error.
 * The Feishu SDK throws HTTP errors as AxiosError; their response.data
 * contains the actual Feishu error payload.
 */
function extractFeishuErrorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === "object") {
    // AxiosError shape: err.response.data.msg
    const axiosErr = err as {
      response?: { data?: { msg?: string; code?: number } };
      message?: string;
    };
    const apiMsg = axiosErr.response?.data?.msg;
    if (apiMsg) return apiMsg;
    if (axiosErr.message) return axiosErr.message;
  }
  return fallback;
}

/**
 * Send an urgent (buzz) notification for an existing Feishu message.
 *
 * Calls the Feishu "urgent" API which sends a strong push notification
 * (buzz) to the specified recipients. The message must already be sent.
 *
 * Requires `im:message:send_urgent_app` scope (or sms/phone variants).
 *
 * Note: Invalid user IDs cause a HTTP 400 error from the Feishu API rather
 * than being silently returned in `invalid_user_id_list`. This function
 * wraps such errors with a descriptive message.
 *
 * @see https://open.feishu.cn/document/server-docs/im-v1/message/urgent_app
 * @see https://open.feishu.cn/document/server-docs/im-v1/message/urgent_sms
 * @see https://open.feishu.cn/document/server-docs/im-v1/message/urgent_phone
 */
export async function urgentMessageFeishu(params: {
  client: Lark.Client;
  messageId: string;
  userIds: string[];
  urgentType?: FeishuUrgentType;
}): Promise<{ invalidUserList: string[] }> {
  const { client, messageId, userIds, urgentType = "app" } = params;

  const larkMessage = client.im.message as LarkMessageWithUrgent;

  const payload: UrgentPayload = {
    path: { message_id: messageId },
    params: { user_id_type: "open_id" },
    data: { user_id_list: userIds },
  };

  const methodMap = {
    app: larkMessage.urgentApp?.bind(larkMessage),
    sms: larkMessage.urgentSms?.bind(larkMessage),
    phone: larkMessage.urgentPhone?.bind(larkMessage),
  } as const;

  const method = methodMap[urgentType];
  if (typeof method !== "function") {
    throw new Error(
      `Feishu urgent: SDK method not available for urgentType="${urgentType}". ` +
        `Check that @larksuiteoapi/node-sdk is up to date.`,
    );
  }

  let response: UrgentResponse;
  try {
    response = await method(payload);
  } catch (err) {
    // Feishu API returns HTTP 400 for invalid user IDs or other request errors.
    // Wrap the error with a clear message instead of surfacing a raw AxiosError.
    const msg = extractFeishuErrorMessage(err, `Feishu urgent (${urgentType}) request failed`);
    throw new Error(`Feishu urgent message (${urgentType}) failed: ${msg}`);
  }

  if (response.code !== 0) {
    throw new Error(
      `Feishu urgent message (${urgentType}) failed: ${response.msg || `code ${response.code}`}`,
    );
  }

  return {
    invalidUserList: response.data?.invalid_user_id_list ?? [],
  };
}
