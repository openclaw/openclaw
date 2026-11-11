import { resolveAgentConfig } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { DEFAULT_MEMORY_FILE_MAX_CHARS } from "./memory-budget.js";

/**
 * Keep promotion output within every consuming agent's per-file bootstrap
 * budget. An unconfigured bootstrap limit stays above the promotion writer's
 * own ceiling, so only explicit lower limits need to reduce the budget here.
 */
export function resolveMemoryPromotionFileMaxChars(params: {
  cfg?: OpenClawConfig;
  agentIds: readonly string[];
}): number {
  const defaultBootstrapLimit = params.cfg?.agents?.defaults?.bootstrapMaxChars;
  const agentIds: Array<string | undefined> =
    params.agentIds.length > 0 ? [...new Set(params.agentIds)] : [undefined];
  let limit = DEFAULT_MEMORY_FILE_MAX_CHARS;

  for (const agentId of agentIds) {
    const configuredLimit = agentId
      ? (resolveAgentConfig(params.cfg ?? {}, agentId)?.bootstrapMaxChars ?? defaultBootstrapLimit)
      : defaultBootstrapLimit;
    if (configuredLimit !== undefined) {
      limit = Math.min(limit, configuredLimit);
    }
  }
  return limit;
}
