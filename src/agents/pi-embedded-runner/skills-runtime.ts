import type { OpenClawConfig } from "../../config/config.js";
import { loadWorkspaceSkillEntries, type SkillEntry, type SkillSnapshot } from "../skills.js";

export function resolveEmbeddedRunSkillEntries(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  skillsSnapshot?: SkillSnapshot;
  preferWorkspaceEntries?: boolean;
}): {
  shouldLoadSkillEntries: boolean;
  skillEntries: SkillEntry[];
} {
  const shouldLoadSkillEntries =
    params.preferWorkspaceEntries ||
    !params.skillsSnapshot ||
    !params.skillsSnapshot.resolvedSkills;
  return {
    shouldLoadSkillEntries,
    skillEntries: shouldLoadSkillEntries
      ? loadWorkspaceSkillEntries(params.workspaceDir, { config: params.config })
      : [],
  };
}
