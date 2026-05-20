/**
 * webhook-bridge — 外部 Webhook 载荷 → Ingress（默认 intent_route）→ 分类 Playbook
 *
 * 与 im-bridge 对称；Ingress 默认策略见 DEFAULT_INGRESS_POLICIES（webhook-intent-route）。
 */

import { applyIngressPublish } from "./ingress-publish.js";
import type { ClaworksRuntime } from "./runtime-types.js";

export type WebhookBridgeInput = {
  /** 逻辑来源标识（MES、SCADA、自定义集成名） */
  source: string;
  /** 幂等 ID（可选，默认生成） */
  webhookId?: string;
  /** 载荷：对象或 JSON 字符串 */
  body: Record<string, unknown> | string;
  /** 调用方主体（用于 RBAC，默认 webhook:source） */
  subjectId?: string;
  extra?: Record<string, unknown>;
};

export type WebhookBridgeResult =
  | { action: "denied"; reason: string }
  | { action: "observe_only" }
  | { action: "intent_routed"; playbookId: string; runId: string; status: string }
  | { action: "published"; eventType: string; matchedPlaybooks: string[] };

export async function bridgeWebhookPayload(
  runtime: ClaworksRuntime,
  input: WebhookBridgeInput,
): Promise<WebhookBridgeResult> {
  const source = "webhook";
  const eventType = "webhook.payload.received";
  const subjectId = input.subjectId ?? `webhook:${input.source}`;
  const webhookId = input.webhookId ?? `wh-${Date.now()}`;
  const bodyText = typeof input.body === "string" ? input.body : JSON.stringify(input.body);

  const decision = runtime.ingress.decide(source, eventType, subjectId);

  const rbacAction = decision.action === "intent_route" ? "playbook.trigger" : "event.publish";
  const rbacResource =
    decision.action === "intent_route"
      ? `playbook:${decision.hint ?? "classify_webhook_to_business_event"}`
      : "webhook.*";

  const rbacResult = runtime.rbac.check({
    action: rbacAction,
    resource: rbacResource,
    subjectType: "channel_user",
    subjectId,
    context: { webhook_source: input.source },
  });

  if (!rbacResult.allowed) {
    const reason = rbacResult.reason ?? "policy denied";
    await runtime.kernel.publish("rbac.denied", "webhook-bridge", {
      action: rbacAction,
      resource: rbacResource,
      subject_type: "channel_user",
      subject_id: subjectId,
      reason,
    });
    return { action: "denied", reason };
  }

  const payload: Record<string, unknown> = {
    _webhook_source: input.source,
    _webhook_id: webhookId,
    _webhook_body: bodyText,
    _ingress_decision: decision.action,
    ...input.extra,
  };

  const result = await applyIngressPublish(runtime, {
    source,
    eventType,
    subjectId,
    payload,
    publishSource: `webhook-bridge:${input.source}`,
    idempotencyKey: `webhook:${input.source}:${webhookId}`,
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
