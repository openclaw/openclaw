import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isStrictAgenticExecutionContractActive } from "./execution-contract.js";
import type { AnyAgentTool } from "./tools/common.js";

export function collectPresentOpenClawTools(
  candidates: readonly (AnyAgentTool | null | undefined)[],
): AnyAgentTool[] {
  return candidates.filter((tool): tool is AnyAgentTool => tool !== null && tool !== undefined);
}

export function isUpdatePlanToolEnabledForOpenClawTools(params: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
  agentId?: string | null;
  modelProvider?: string;
  modelId?: string;
}): boolean {
  const configured = params.config?.tools?.experimental?.planTool;
  if (configured !== undefined) {
    return configured;
  }
  return isStrictAgenticExecutionContractActive({
    config: params.config,
    sessionKey: params.agentSessionKey,
    agentId: params.agentId,
    provider: params.modelProvider,
    modelId: params.modelId,
  });
}

/**
 * Plan-mode tools (`enter_plan_mode` / `exit_plan_mode`) are gated on
 * `agents.defaults.planMode.enabled`. Default OFF — opt-in feature so a
 * default GPT-5.4 / Claude Sonnet run does NOT see these tools and
 * doesn't accidentally fall into a plan-first workflow.
 *
 * Once enabled, the tools appear in the tool catalog AND the runtime
 * mutation gate (src/agents/plan-mode/mutation-gate.ts) starts enforcing
 * the block-mutations contract whenever a session has
 * `planMode.mode === "plan"`.
 */
export function isPlanModeToolsEnabledForOpenClawTools(params: {
  config?: OpenClawConfig;
}): boolean {
  return params.config?.agents?.defaults?.planMode?.enabled === true;
}
