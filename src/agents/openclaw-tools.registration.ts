import type { OpenClawConfig } from "../config/config.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import type { AnyAgentTool } from "./tools/common.js";

export function collectPresentOpenClawTools(
  candidates: readonly (AnyAgentTool | null | undefined)[],
): AnyAgentTool[] {
  return candidates.filter((tool): tool is AnyAgentTool => tool !== null && tool !== undefined);
}

function isOpenAIProvider(provider?: string): boolean {
  const normalized = normalizeOptionalLowercaseString(provider);
  return normalized === "openai" || normalized === "openai-codex";
}

export function isUpdatePlanToolEnabledForOpenClawTools(
  config: OpenClawConfig | undefined,
  provider?: string,
): boolean {
  const configured = config?.tools?.experimental?.planTool;
  if (configured !== undefined) {
    return configured;
  }
  return isOpenAIProvider(provider);
}
