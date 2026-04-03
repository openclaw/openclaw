import type { OpenClawConfig } from "../../config/config.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { normalizeSkillFilter } from "./filter.js";

export function resolveEffectiveAgentSkillFilter(
  cfg: OpenClawConfig | undefined,
  agentId: string | undefined,
): string[] | undefined {
  if (!cfg) {
    return undefined;
  }
  const normalizedAgentId = normalizeAgentId(agentId);
  const agentEntry = cfg.agents?.list?.find(
    (entry) => normalizeAgentId(entry.id) === normalizedAgentId,
  );
  if (agentEntry && Object.hasOwn(agentEntry, "skills")) {
    return normalizeSkillFilter(agentEntry.skills);
  }
  return normalizeSkillFilter(cfg.agents?.defaults?.skills);
}
