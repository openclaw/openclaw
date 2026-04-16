/**
 * Skill plan template instantiation.
 *
 * When a skill with a `planTemplate` in its metadata is activated,
 * this module builds the initial `update_plan` call payload from
 * the template steps. All steps start as "pending".
 *
 * This is Phase 4.1 of the GPT 5.4 parity sprint — a differentiator
 * feature not present in Hermes or Claude Code.
 */

import type { SkillPlanTemplateStep } from "./types.js";

export interface PlanTemplatePayload {
  plan: Array<{
    step: string;
    status: "pending";
    activeForm?: string;
  }>;
  explanation: string;
}

/**
 * Builds an `update_plan` payload from a skill's plan template.
 *
 * @param skillName - The name of the skill being activated
 * @param template - The plan template steps from skill metadata
 * @returns A payload suitable for passing to the `update_plan` tool,
 *          or `null` if the template is empty
 */
export function buildPlanTemplatePayload(
  skillName: string,
  template: SkillPlanTemplateStep[],
): PlanTemplatePayload | null {
  if (!template || template.length === 0) {
    return null;
  }

  return {
    plan: template.map((t) => ({
      step: t.step,
      status: "pending" as const,
      ...(t.activeForm ? { activeForm: t.activeForm } : {}),
    })),
    explanation: `Auto-populated from skill "${skillName}" plan template.`,
  };
}

/**
 * Checks whether a skill entry has a non-empty plan template.
 */
export function hasSkillPlanTemplate(metadata?: { planTemplate?: SkillPlanTemplateStep[] }): boolean {
  return Array.isArray(metadata?.planTemplate) && metadata.planTemplate.length > 0;
}
