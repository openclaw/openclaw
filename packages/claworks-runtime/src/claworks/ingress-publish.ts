/**
 * applyIngressPublish — 统一 Ingress 决策执行（kernel / intent_route / observe / deny）。
 *
 * intent_route 时直接 trigger 分类 Playbook，避免 im.message.received 泛洪 EventBus。
 */

import type { IngressDecision, IngressSource } from "../kernel/ingress.js";
import type { CwEvent } from "../kernel/types.js";
import { DEFAULT_ROBOT_CONSTITUTION, isTrustedEventSource } from "./robot-constitution.js";
import type { ClaworksRuntime } from "./runtime-types.js";

export type IngressPublishParams = {
  source: IngressSource;
  eventType: string;
  subjectId: string;
  payload: Record<string, unknown>;
  correlationId?: string;
  traceparent?: string;
  subjectType?: CwEvent["subjectType"];
  idempotencyKey?: string;
  /** kernel.publish 的 source 字段（默认 subjectId） */
  publishSource?: string;
};

export type IngressPublishResult =
  | { action: "denied"; reason: string }
  | { action: "observe_only" }
  | {
      action: "intent_routed";
      playbookId: string;
      runId: string;
      status: string;
    }
  | {
      action: "published";
      eventType: string;
      matchedPlaybooks: string[];
    };

export async function applyIngressPublish(
  runtime: ClaworksRuntime,
  params: IngressPublishParams,
): Promise<IngressPublishResult> {
  const publishSource = params.publishSource ?? params.subjectId;
  const constitution = DEFAULT_ROBOT_CONSTITUTION;
  if (!isTrustedEventSource(constitution, publishSource)) {
    runtime.logger?.(
      `[claworks:ingress] untrusted source "${publishSource}" — denied by robot constitution`,
    );
    return {
      action: "denied",
      reason: `untrusted event source: ${publishSource}`,
    };
  }

  const decision = runtime.ingress.decide(params.source, params.eventType, params.subjectId);

  if (decision.action === "deny") {
    return { action: "denied", reason: decision.reason ?? "ingress policy denied" };
  }

  if (decision.action === "observe_only") {
    return { action: "observe_only" };
  }

  if (decision.action === "intent_route") {
    return routeIntentPlaybook(runtime, decision, params);
  }

  const effectiveType =
    decision.action === "kernel" && decision.eventType ? decision.eventType : params.eventType;

  const matches = await runtime.kernel.publish(
    effectiveType,
    params.publishSource ?? params.subjectId,
    params.payload,
    {
      correlationId: params.correlationId,
      traceparent: params.traceparent,
      idempotencyKey: params.idempotencyKey,
      subjectType: params.subjectType,
      subjectId: params.subjectId,
    },
  );

  return {
    action: "published",
    eventType: effectiveType,
    matchedPlaybooks: matches.map((m) => m.playbookId),
  };
}

async function routeIntentPlaybook(
  runtime: ClaworksRuntime,
  decision: Extract<IngressDecision, { action: "intent_route" }>,
  params: IngressPublishParams,
): Promise<IngressPublishResult> {
  const hint = decision.hint ?? "classify_im_to_business_event";
  const playbook = runtime.playbookEngine.list().find((p) => p.id === hint);
  if (!playbook) {
    runtime.logger?.(`[claworks:ingress] intent_route playbook missing: ${hint} — observe only`);
    return { action: "observe_only" };
  }

  const payload: Record<string, unknown> = {
    ...params.payload,
    _ingress_decision: "intent_route",
    _ingress_event_type: params.eventType,
    _ingress_source: params.source,
  };

  const run = await runtime.playbookEngine.trigger(hint, payload);
  return {
    action: "intent_routed",
    playbookId: hint,
    runId: run.id,
    status: run.status,
  };
}
