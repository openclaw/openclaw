import type * as Lark from "@larksuiteoapi/node-sdk";

/**
 * Urgency type for Feishu urgent messages.
 * - "app": In-app buzz notification (default, no extra cost)
 * - "sms": SMS push to the recipient's phone
 * - "phone": Voice call to the recipient's phone
 */
export type FeishuUrgentType = "app" | "sms" | "phone";

/**
 * Send an urgent (buzz) notification for an existing Feishu message.
 *
 * Calls the Feishu "urgent" PATCH API which sends a strong push notification
 * (buzz) to the specified recipients. The message must already be sent.
 *
 * Requires the `im:message:send_urgent_app` scope (or sms/phone variants).
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

  type UrgentResponse = {
    code?: number;
    msg?: string;
    data?: { invalid_user_id_list?: string[] };
  };

  // The Lark SDK exposes urgent APIs directly on client.im.message
  const larkMessage = client.im.message as unknown as {
    urgentApp?: (p: {
      path: { message_id: string };
      params: { user_id_type: string };
      data: { user_id_list: string[] };
    }) => Promise<UrgentResponse>;
    urgentSms?: (p: {
      path: { message_id: string };
      params: { user_id_type: string };
      data: { user_id_list: string[] };
    }) => Promise<UrgentResponse>;
    urgentPhone?: (p: {
      path: { message_id: string };
      params: { user_id_type: string };
      data: { user_id_list: string[] };
    }) => Promise<UrgentResponse>;
  };

  const sdkMethodMap = {
    app: larkMessage.urgentApp?.bind(larkMessage),
    sms: larkMessage.urgentSms?.bind(larkMessage),
    phone: larkMessage.urgentPhone?.bind(larkMessage),
  };

  const sdkMethod = sdkMethodMap[urgentType];

  const requestBody = {
    path: { message_id: messageId },
    params: { user_id_type: "open_id" },
    data: { user_id_list: userIds },
  };

  let response: UrgentResponse;

  if (typeof sdkMethod === "function") {
    response = await sdkMethod(requestBody);
  } else {
    // Fall back to raw HTTP request via the Lark client
    const rawClient = client as unknown as {
      request: (config: {
        method: string;
        url: string;
        params?: Record<string, string>;
        data?: unknown;
      }) => Promise<UrgentResponse>;
    };

    const endpointMap: Record<FeishuUrgentType, string> = {
      app: "urgent_app",
      sms: "urgent_sms",
      phone: "urgent_phone",
    };

    if (typeof rawClient.request !== "function") {
      throw new Error(
        `Feishu urgent: neither SDK method nor raw request available for urgentType="${urgentType}"`,
      );
    }

    response = await rawClient.request({
      method: "PATCH",
      url: `/open-apis/im/v1/messages/${messageId}/${endpointMap[urgentType]}`,
      params: { user_id_type: "open_id" },
      data: { user_id_list: userIds },
    });
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
