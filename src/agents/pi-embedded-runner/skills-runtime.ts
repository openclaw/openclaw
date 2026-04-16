import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadWorkspaceSkillEntries, type SkillEntry, type SkillSnapshot } from "../skills.js";
import { resolveSkillRuntimeConfig } from "../skills/runtime-config.js";
import { buildPlanTemplatePayload, hasSkillPlanTemplate, type PlanTemplatePayload } from "../skills/skill-planner.js";

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

/**
 * Checks activated skill entries for a plan template and returns
 * the `update_plan` payload if one is found. Returns `null` if no
 * activated skill has a plan template.
 */
export function resolveSkillPlanTemplate(entries: SkillEntry[]): PlanTemplatePayload | null {
  for (const entry of entries) {
    if (hasSkillPlanTemplate(entry.metadata) && entry.metadata?.planTemplate) {
      return buildPlanTemplatePayload(entry.skill.name, entry.metadata.planTemplate);
    }
  }
  return null;
}
