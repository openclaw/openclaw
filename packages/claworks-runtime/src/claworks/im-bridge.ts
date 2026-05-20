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

export type ImBridgeResult =
  | { action: "denied"; reason: string }
  | { action: "observe_only" }
  | { action: "skipped"; reason: string }
  | { action: "intent_routed"; playbookId: string; runId: string; status: string }
  | { action: "published"; eventType: string; matchedPlaybooks: string[] };

export async function bridgeImMessage(
  runtime: ClaworksRuntime,
  input: ImBridgeInput,
): Promise<ImBridgeResult> {
  const source = "im";
  const eventType = "im.message.received";
  const subjectId = `${input.channel}:${input.userId}`;
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
    context: { channel: input.channel },
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

  const payload: Record<string, unknown> = {
    _im_channel: input.channel,
    _im_message_id: input.messageId,
    _im_user_id: input.userId,
    _im_group_id: input.groupId,
    _im_message: input.text,
    _ingress_decision: decision.action,
    ...input.extra,
  };

  const result = await applyIngressPublish(runtime, {
    source,
    eventType,
    subjectId,
    payload,
    publishSource: "im-bridge",
    idempotencyKey: `im:${input.channel}:${input.messageId}`,
    subjectType: "channel_user",
  });

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
