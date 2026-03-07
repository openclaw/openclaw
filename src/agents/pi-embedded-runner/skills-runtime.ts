import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  loadWorkspaceSkillEntries,
  type SkillEligibilityContext,
  type SkillEntry,
  type SkillSnapshot,
} from "../skills.js";
import { resolveSkillRuntimeConfig } from "../skills/runtime-config.js";

export function resolveEmbeddedRunSkillEntries(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  agentId?: string;
  skillsSnapshot?: SkillSnapshot;
  forceLoadEntries?: boolean;
  eligibility?: SkillEligibilityContext;
}): {
  shouldLoadSkillEntries: boolean;
  skillEntries: SkillEntry[];
} {
  const shouldLoadSkillEntries =
    !!params.forceLoadEntries || !params.skillsSnapshot || !params.skillsSnapshot.resolvedSkills;
  const config = resolveSkillRuntimeConfig(params.config);
  const skillFilter = params.skillsSnapshot?.skillFilter;
  return {
    shouldLoadSkillEntries,
    skillEntries: shouldLoadSkillEntries
      ? loadWorkspaceSkillEntries(params.workspaceDir, {
          config,
          ...(params.agentId === undefined ? {} : { agentId: params.agentId }),
          ...(skillFilter === undefined ? {} : { skillFilter }),
          ...(params.eligibility === undefined ? {} : { eligibility: params.eligibility }),
        })
      : [],
  };
}
