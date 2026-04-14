import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  isStrictAgenticExecutionContractActive,
  isStrictAgenticSupportedProviderModel,
} from "./execution-contract.js";
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
  // Auto-enable update_plan only for supported provider/model combinations
  // where strict-agentic is active. Operators on other providers can use
  // tools.experimental.planTool: true to force-enable.
  return (
    isStrictAgenticExecutionContractActive({
      config: params.config,
      sessionKey: params.agentSessionKey,
      agentId: params.agentId,
      provider: params.modelProvider,
      modelId: params.modelId,
    }) &&
    isStrictAgenticSupportedProviderModel({
      provider: params.modelProvider,
      modelId: params.modelId,
    })
  );
}
