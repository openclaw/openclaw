import type { ConfiguredWebhookDeliveryConfig } from "./config.js";
import type { AgentWebhookTarget, ScheduleSessionTurn, WebhookLogger } from "./http.js";
import {
  applySkillHint,
  buildDefaultWebhookPrompt,
  renderOptionalTemplate,
  sanitizeSchedulerToken,
  type WebhookDispatchContext,
} from "./template.js";

export type WebhookAgentCompletionDispatch = {
  routeId: string;
  sessionKey: string;
  delivery: ConfiguredWebhookDeliveryConfig;
  context: WebhookDispatchContext;
};

export async function executeAgentDispatch(params: {
  target: AgentWebhookTarget;
  context: WebhookDispatchContext;
  scheduleSessionTurn?: ScheduleSessionTurn;
  onAgentCompletionDispatch?: (dispatch: WebhookAgentCompletionDispatch) => void | Promise<void>;
  logger?: WebhookLogger;
}): Promise<{ statusCode: number; body: unknown }> {
  const { target, context } = params;
  const message =
    renderOptionalTemplate(target.agent.messageTemplate, context) ??
    renderOptionalTemplate(target.prompt, context) ??
    buildDefaultWebhookPrompt(context);
  const scheduler = params.scheduleSessionTurn;
  const name = renderOptionalTemplate(target.agent.nameTemplate, context);
  const tag = sanitizeSchedulerToken(renderOptionalTemplate(target.agent.tagTemplate, context));
  if (!scheduler) {
    return {
      statusCode: 503,
      body: {
        ok: false,
        routeId: target.routeId,
        code: "agent_dispatch_unavailable",
        error: "Agent dispatch is unavailable in this Gateway runtime.",
      },
    };
  }
  const scheduleRequest = {
    sessionKey: target.sessionKey,
    message: applySkillHint(message, target.skills),
    deliveryMode: target.agent.deliveryMode,
    delayMs: target.agent.delayMs,
    deleteAfterRun: true,
    ...(target.agent.agentId ? { agentId: target.agent.agentId } : {}),
    ...(name ? { name } : {}),
    ...(tag ? { tag } : {}),
  };
  if (target.agent.onCompletion) {
    await params.onAgentCompletionDispatch?.({
      routeId: target.routeId,
      sessionKey: target.sessionKey,
      delivery: target.agent.onCompletion.delivery,
      context,
    });
  }
  let handle: Awaited<ReturnType<ScheduleSessionTurn>>;
  try {
    handle = await scheduler(scheduleRequest);
  } catch (error) {
    params.logger?.warn?.("[webhooks] agent dispatch failed", {
      routeId: target.routeId,
      sessionKey: target.sessionKey,
      ...(context.eventType ? { eventType: context.eventType } : {}),
      ...(context.idempotencyKey ? { idempotencyKey: context.idempotencyKey } : {}),
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      statusCode: 503,
      body: {
        ok: false,
        routeId: target.routeId,
        code: "agent_dispatch_failed",
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
  if (!handle) {
    params.logger?.warn?.("[webhooks] agent dispatch was rejected", {
      routeId: target.routeId,
      sessionKey: target.sessionKey,
      ...(context.eventType ? { eventType: context.eventType } : {}),
      ...(context.idempotencyKey ? { idempotencyKey: context.idempotencyKey } : {}),
      deliveryMode: target.agent.deliveryMode,
      delayMs: target.agent.delayMs,
      ...(name ? { name } : {}),
      ...(tag ? { tag } : {}),
    });
    return {
      statusCode: 503,
      body: {
        ok: false,
        routeId: target.routeId,
        code: "agent_dispatch_rejected",
        error: "Agent dispatch was rejected by the Gateway scheduler.",
      },
    };
  }
  params.logger?.info?.("[webhooks] agent dispatch scheduled", {
    routeId: target.routeId,
    sessionKey: handle.sessionKey,
    jobId: handle.id,
    ...(context.eventType ? { eventType: context.eventType } : {}),
    ...(context.idempotencyKey ? { idempotencyKey: context.idempotencyKey } : {}),
  });
  return {
    statusCode: 202,
    body: {
      ok: true,
      routeId: target.routeId,
      result: {
        action: "agent_dispatch",
        sessionKey: target.sessionKey,
        accepted: true,
        jobId: handle.id,
        ...(target.agent.onCompletion ? { completionDelivery: true } : {}),
      },
    },
  };
}
