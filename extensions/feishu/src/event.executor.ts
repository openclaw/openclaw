import {
  agentCommandFromIngress,
  type AgentCommandIngressOpts,
} from "openclaw/plugin-sdk/agent-runtime";
import type { RuntimeEnv } from "../runtime-api.js";
import type { FeishuEventSubscriptionMatch } from "./event.subscription.js";
import type { ResolvedFeishuEventTriggerPlan } from "./event.trigger.js";

export type FeishuEventExecutor = (
  opts: AgentCommandIngressOpts,
  runtime?: RuntimeEnv,
) => Promise<unknown>;

export type FeishuEventExecutionResult = {
  plan: ResolvedFeishuEventTriggerPlan;
  ingress: AgentCommandIngressOpts;
  result: unknown;
};

function resolveBootstrapRunKind(
  mode: ResolvedFeishuEventTriggerPlan["mode"],
): AgentCommandIngressOpts["bootstrapContextRunKind"] {
  return mode === "isolated" ? "cron" : "default";
}

export function buildFeishuEventIngressOpts(
  plan: ResolvedFeishuEventTriggerPlan,
): AgentCommandIngressOpts {
  return {
    message: plan.commandText,
    transcriptMessage: plan.commandText,
    sessionKey: plan.sessionKeyHint,
    agentId: plan.agentId,
    channel: "feishu",
    accountId: plan.event.accountId,
    senderIsOwner: false,
    allowModelOverride: false,
    bootstrapContextMode: "lightweight",
    bootstrapContextRunKind: resolveBootstrapRunKind(plan.mode),
  };
}

export async function executeFeishuEventTriggerPlan(params: {
  plan: ResolvedFeishuEventTriggerPlan;
  runtime?: RuntimeEnv;
  execute?: FeishuEventExecutor;
}): Promise<FeishuEventExecutionResult> {
  const ingress = buildFeishuEventIngressOpts(params.plan);
  const execute = params.execute ?? agentCommandFromIngress;
  const result = await execute(ingress, params.runtime);
  return {
    plan: params.plan,
    ingress,
    result,
  };
}

export function createFeishuEventSubscriptionExecutionHandler(params?: {
  runtime?: RuntimeEnv;
  execute?: FeishuEventExecutor;
  onExecuted?: (result: FeishuEventExecutionResult) => Promise<void> | void;
}) {
  return async (
    match: FeishuEventSubscriptionMatch,
  ): Promise<FeishuEventExecutionResult | null> => {
    if (!match.triggerPlan) {
      return null;
    }
    const result = await executeFeishuEventTriggerPlan({
      plan: match.triggerPlan,
      runtime: params?.runtime,
      execute: params?.execute,
    });
    await params?.onExecuted?.(result);
    return result;
  };
}
