import { shouldIncludeProgressCardToolForOpenClawTools } from "./openclaw-tools.registration.js";
import type { OpenClawToolsOptions } from "./openclaw-tools.types.js";
import { createProgressCardTool } from "./tools/progress-card-tool.js";

export function resolveProgressCardTool(
  options: OpenClawToolsOptions | undefined,
  agentId: string,
  sessionKey: string | undefined,
) {
  return shouldIncludeProgressCardToolForOpenClawTools({ ...options, agentId })
    ? createProgressCardTool({ agentSessionKey: sessionKey, agentId })
    : null;
}
