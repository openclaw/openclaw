/**
 * Feishu live E2E gate helpers — credential checks and ingress payload (CI-safe).
 */

export function resolveFeishuLiveE2eEnv(env = process.env) {
  return {
    appId: env.FEISHU_APP_ID?.trim() ?? "",
    appSecret: env.FEISHU_APP_SECRET?.trim() ?? "",
    chatId: env.FEISHU_TEST_CHAT_ID?.trim() ?? "",
    openId: env.FEISHU_TEST_OPEN_ID?.trim() ?? "",
    gatewayUrl: (env.CLAWORKS_GATEWAY_URL ?? "http://127.0.0.1:18800").replace(/\/$/, ""),
  };
}

/** @returns {{ skip: true, reason: string } | { skip: false, env: ReturnType<typeof resolveFeishuLiveE2eEnv> }} */
export function evaluateFeishuLiveE2eGate(env = process.env) {
  const resolved = resolveFeishuLiveE2eEnv(env);
  if (!resolved.appId || !resolved.appSecret) {
    return {
      skip: true,
      reason:
        "FEISHU_APP_ID / FEISHU_APP_SECRET not set — live E2E requires real Feishu app credentials",
    };
  }
  if (!resolved.chatId && !resolved.openId) {
    return {
      skip: true,
      reason: "FEISHU_TEST_CHAT_ID or FEISHU_TEST_OPEN_ID required for message roundtrip",
    };
  }
  return { skip: false, env: resolved };
}

export function buildFeishuIngressPayload({ chatId, openId, probeText }) {
  const text = probeText ?? `ClaWorks live E2E probe ${Date.now()}`;
  return {
    type: "im.message.received",
    source: "feishu-live-e2e",
    headers: {
      "Content-Type": "application/json",
      "X-ClaWorks-Channel-User": openId ? `feishu:${openId}` : "feishu:live-e2e-user",
    },
    body: {
      type: "im.message.received",
      source: "feishu-live-e2e",
      payload: {
        channel: "feishu",
        channel_id: chatId ?? openId,
        text,
        user_id: openId ?? "live-e2e-user",
      },
    },
  };
}
