import type { OpenClawConfig } from "../config/config.js";
import type { AgentCompactionConfig } from "../config/types.agent-defaults.js";

/**
 * Resolve the effective compaction configuration for a specific agent,
 * merging agent-level overrides with global defaults.
 *
 * Priority: agent.list[agentId].compaction → agents.defaults.compaction
 */
export function resolveAgentCompaction(
  cfg: OpenClawConfig | undefined,
  agentId: string | undefined,
): AgentCompactionConfig | undefined {
  const defaults = cfg?.agents?.defaults?.compaction;
  if (!agentId || !cfg?.agents?.list) {
    return defaults;
  }
  const agentEntry = cfg.agents.list.find((a) => a.id === agentId);
  const agentCompaction = agentEntry?.compaction;
  if (!agentCompaction) {
    return defaults;
  }
  return { ...defaults, ...agentCompaction };
}
