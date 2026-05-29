import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSkillRuntimeConfig } from "../../skills/loading/runtime-config.js";
import { loadWorkspaceSkillEntries } from "../../skills/loading/workspace.js";
import type { SkillEntry, SkillSnapshot } from "../../skills/types.js";

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
  return {
    shouldLoadSkillEntries,
    skillEntries: shouldLoadSkillEntries
      ? loadWorkspaceSkillEntries(params.workspaceDir, { config, agentId: params.agentId })
      : [],
  };
}
