import type { OpenClawConfig } from "../config/config.js";
import type { AgentCompactionConfig } from "../config/types.agent-defaults.js";
import { normalizeAgentId } from "../routing/session-key.js";

/**
 * Resolve the effective compaction configuration for a specific agent,
 * merging agent-level overrides with global defaults.
 *
 * Priority: agent.list[agentId].compaction → agents.defaults.compaction
 *
 * Agent IDs are normalized before lookup to ensure case-insensitive matching.
 */
export function resolveAgentCompaction(
  cfg: OpenClawConfig | undefined,
  agentId: string | undefined,
): AgentCompactionConfig | undefined {
  const defaults = cfg?.agents?.defaults?.compaction;
  if (!agentId || !cfg?.agents?.list) {
    return defaults;
  }
  const normalizedId = normalizeAgentId(agentId);
  const agentEntry = cfg.agents.list.find(
    (a) => normalizeAgentId(a.id) === normalizedId,
  );
  const agentCompaction = agentEntry?.compaction;
  if (!agentCompaction) {
    return defaults;
  }
  return { ...defaults, ...agentCompaction };
}
