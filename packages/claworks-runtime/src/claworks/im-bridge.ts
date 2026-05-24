/**
 * im-bridge — IM 消息 → ClaWorks EventKernel 的意图路由桥梁
 *
 * 设计原则：
 * - IM 消息默认不自动进入 EventKernel（避免垃圾事件洪泛）
 * - 由 Pi Agent（Pi代理）或 Webhook 调用本桥显式转发
 * - IngressRouter 决策：kernel直达 | intent_route（LLM分类后再决定是否发布）| observe_only | deny
 * - intent_route 时直接 trigger classify_im_to_business_event（不经 EventBus 泛洪）
 * - Playbook 再用 LLM 判断意图，若匹配业务模式则发布具体业务事件
 *
 * 调用路径：
 * 1. Pi Agent 在聊天循环末尾调用工具 cw_bridge_im_message
 * 2. IM Connector（飞书/企微/钉钉 Webhook）POST /v1/bridge/im
 * 3. 未来：OpenClaw 提供 api.onChannelMessage hook 后可自动注册
 */

import { applyIngressPublish } from "./ingress-publish.js";
import type { ClaworksRuntime } from "./runtime-types.js";

export type ImBridgeInput = {
  /** IM 频道标识，例如 feishu | weixin-work | dingtalk */
  channel: string;
  /** 平台原始消息 ID（用于幂等性） */
  messageId: string;
  /** 用户 ID（平台内） */
  userId: string;
  /** 消息纯文本内容 */
  text: string;
  /** 群组 / 会话 ID（可选） */
  groupId?: string;
  /** 附加元数据（图片 URL、文件、@ 列表等） */
  extra?: Record<string, unknown>;
};

/** Accept REST/legacy snake_case aliases before routing. */
export function normalizeImBridgeInput(
  input: ImBridgeInput & Record<string, unknown>,
): ImBridgeInput {
  const channel = String(input.channel ?? input.channel_id ?? "").trim();
  const userId = String(input.userId ?? input.user_id ?? "").trim();
  const text = String(input.text ?? input.message ?? "").trim();
  const messageId = String(
    input.messageId ??
      input.message_id ??
      `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const groupRaw = input.groupId ?? input.group_id;
  const extra =
    input.extra ?? (input.tenant_id != null ? { tenant_id: input.tenant_id } : undefined);
  return {
    channel,
    messageId,
    userId: userId || "anonymous",
    text,
    groupId: groupRaw != null ? String(groupRaw) : undefined,
    extra: extra as Record<string, unknown> | undefined,
  };
}

export type ImBridgeResult =
  | { action: "denied"; reason: string }
  | { action: "observe_only" }
  | { action: "skipped"; reason: string }
  | { action: "intent_routed"; playbookId: string; runId: string; status: string }
  | { action: "published"; eventType: string; matchedPlaybooks: string[] };

export async function bridgeImMessage(
  runtime: ClaworksRuntime,
  input: ImBridgeInput & Record<string, unknown>,
): Promise<ImBridgeResult> {
  const normalized = normalizeImBridgeInput(input);
  const source = "im";
  const eventType = "im.message.received";
  const subjectId = `${normalized.channel}:${normalized.userId}`;
  const decision = runtime.ingress.decide(source, eventType, subjectId);

  const rbacAction = decision.action === "intent_route" ? "playbook.trigger" : "event.publish";
  const rbacResource =
    decision.action === "intent_route"
      ? `playbook:${decision.hint ?? "classify_im_to_business_event"}`
      : eventType;

  const rbacResult = runtime.rbac.check({
    action: rbacAction,
    resource: rbacResource,
    subjectType: "channel_user",
    subjectId,
    context: { channel: normalized.channel },
  });

  if (!rbacResult.allowed) {
    const reason = rbacResult.reason ?? "policy denied";
    await runtime.kernel.publish("rbac.denied", "im-bridge", {
      action: rbacAction,
      resource: rbacResource,
      subject_type: "channel_user",
      subject_id: subjectId,
      reason,
    });
    return { action: "denied", reason };
  }

  const sessionId = normalized.groupId
    ? `${normalized.channel}:group:${normalized.groupId}`
    : `${normalized.channel}:user:${normalized.userId}`;

  const payload: Record<string, unknown> = {
    _im_channel: normalized.channel,
    _im_message_id: normalized.messageId,
    _im_user_id: normalized.userId,
    _im_group_id: normalized.groupId,
    _im_message: normalized.text,
    _ingress_decision: decision.action,
    // 规范化别名：Playbook 可通过 event.payload.text / payload.text 等方式访问
    text: normalized.text,
    user_id: normalized.userId,
    channel: normalized.channel,
    message_id: normalized.messageId,
    group_id: normalized.groupId ?? null,
    session_id: sessionId,
    timestamp: new Date().toISOString(),
    ...normalized.extra,
  };

  // 将用户消息追加到对话上下文，供 Playbook 中 _session 变量使用
  runtime.contextEngine?.append(sessionId, "user", normalized.text, {
    channel: normalized.channel,
    userId: normalized.userId,
    messageId: normalized.messageId,
  });

  const result = await applyIngressPublish(runtime, {
    source,
    eventType,
    subjectId,
    payload,
    publishSource: "im-bridge",
    idempotencyKey: `im:${normalized.channel}:${normalized.messageId}`,
    subjectType: "channel_user",
  });

  // Publish user.first_interaction for welcome_new_user Playbook when the user
  // profile store sees this user for the very first time.
  if (result.action !== "denied" && runtime.userProfileStore && normalized.userId !== "anonymous") {
    const profile = runtime.userProfileStore.get(normalized.userId);
    const isFirstInteraction = !profile || profile.interactionCount === 0;
    if (isFirstInteraction) {
      await runtime.kernel
        .publish("user.first_interaction", "im-bridge", {
          channel: normalized.channel,
          user_id: normalized.userId,
          group_id: normalized.groupId,
          first_message: normalized.text,
        })
        .catch(() => {});
    }
  }

  if (result.action === "denied") {
    return { action: "denied", reason: result.reason };
  }
  if (result.action === "observe_only") {
    return { action: "observe_only" };
  }
  if (result.action === "intent_routed") {
    return {
      action: "intent_routed",
      playbookId: result.playbookId,
      runId: result.runId,
      status: result.status,
    };
  }
  return {
    action: "published",
    eventType: result.eventType,
    matchedPlaybooks: result.matchedPlaybooks,
  };
}
