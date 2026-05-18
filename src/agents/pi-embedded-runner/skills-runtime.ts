import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadWorkspaceSkillEntries, type SkillEntry, type SkillSnapshot } from "../skills.js";
import { resolveEffectiveAgentSkillFilter } from "../skills/agent-filter.js";
import { resolveSkillRuntimeConfig } from "../skills/runtime-config.js";

export function resolveEmbeddedRunSkillEntries(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  agentId?: string;
  skillsSnapshot?: SkillSnapshot;
}): {
  shouldLoadSkillEntries: boolean;
  skillEntries: SkillEntry[];
} {
  const shouldLoadSkillEntries = !params.skillsSnapshot || !params.skillsSnapshot.resolvedSkills;
  const config = resolveSkillRuntimeConfig(params.config);
  const effectiveSkillFilter = resolveEffectiveAgentSkillFilter(config, params.agentId);
  const hasSnapshotPrompt = Boolean(params.skillsSnapshot?.prompt?.trim());
  if (shouldLoadSkillEntries && effectiveSkillFilter?.length === 0 && !hasSnapshotPrompt) {
    return { shouldLoadSkillEntries, skillEntries: [] };
  }
  return {
    shouldLoadSkillEntries,
    skillEntries: shouldLoadSkillEntries
      ? loadWorkspaceSkillEntries(params.workspaceDir, { config, agentId: params.agentId })
      : [],
  };
}
