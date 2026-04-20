/**
 * Skill plan template instantiation.
 *
 * When a skill with a `planTemplate` in its metadata is activated,
 * this module builds the initial plan SEED PAYLOAD from the template
 * steps. All steps start as "pending".
 *
 * PR-E review fix (Copilot #3105170493 / #3096799587): the returned
 * `PlanTemplatePayload` is NOT passed directly to the `update_plan`
 * tool — it's wrapped into an `agent_plan_event` by
 * `applySkillPlanTemplateSeed` (`src/agents/pi-embedded-runner/skills-runtime.ts`)
 * so the UI/channel adapters see the seeded plan ahead of the first
 * agent turn. The extra fields (`droppedDuplicates`, `truncated`,
 * `maxSteps`) are diagnostic — used by the seeder to log
 * `skill_plan_template_*` warnings but stripped before any downstream
 * tool input.
 *
 * Phase 4.1 of the GPT 5.4 parity sprint.
 */

import type { SkillPlanTemplateStep } from "./types.js";

/** Default upper bound on plan-template step count (configurable via `skills.limits.maxPlanTemplateSteps`). */
export const DEFAULT_MAX_PLAN_TEMPLATE_STEPS = 50;

export interface PlanTemplatePayload {
  plan: Array<{
    step: string;
    status: "pending";
    activeForm?: string;
  }>;
  explanation: string;
  /** Step texts dropped because they duplicate an earlier entry in the same template (first wins). */
  droppedDuplicates?: string[];
  /** True when the input template exceeded `maxSteps` and was truncated. */
  truncated?: boolean;
  /** Configured upper bound applied during normalization. */
  maxSteps?: number;
}

export interface BuildPlanTemplateOptions {
  /** Upper bound on step count; defaults to `DEFAULT_MAX_PLAN_TEMPLATE_STEPS`. */
  maxSteps?: number;
}

/**
 * Builds an `update_plan` payload from a skill's plan template.
 *
 * Normalizes the template by:
 * - Dropping entries with duplicate `step` text (first wins).
 * - Truncating to `maxSteps` (default 50, configurable).
 *
 * Diagnostic fields (`droppedDuplicates`, `truncated`, `maxSteps`) on the
 * returned payload let the caller emit per-skill warning events without
 * needing access to the original template.
 *
 * @param skillName - The name of the skill being activated
 * @param template - The plan template steps from skill metadata
 * @param options - Optional limits/overrides
 * @returns A payload suitable for passing to the `update_plan` tool,
 *          or `null` if the (post-normalize) template is empty
 */
export function buildPlanTemplatePayload(
  skillName: string,
  template?: SkillPlanTemplateStep[],
  options?: BuildPlanTemplateOptions,
): PlanTemplatePayload | null {
  if (!template || template.length === 0) {
    return null;
  }

  const maxSteps =
    options?.maxSteps && options.maxSteps > 0 ? options.maxSteps : DEFAULT_MAX_PLAN_TEMPLATE_STEPS;

  // Dedup by step text — keep first occurrence, record dropped duplicates.
  const seen = new Set<string>();
  const droppedDuplicates: string[] = [];
  const deduped: SkillPlanTemplateStep[] = [];
  for (const step of template) {
    if (seen.has(step.step)) {
      droppedDuplicates.push(step.step);
      continue;
    }
    seen.add(step.step);
    deduped.push(step);
  }

  if (deduped.length === 0) {
    return null;
  }

  // Apply upper bound. Truncation drops the tail, since later steps are
  // less likely to be reached anyway and we want the seed to model the
  // "first N actions" the agent should take.
  const truncated = deduped.length > maxSteps;
  const final = truncated ? deduped.slice(0, maxSteps) : deduped;

  return {
    plan: final.map((t) => ({
      step: t.step,
      status: "pending" as const,
      ...(t.activeForm ? { activeForm: t.activeForm } : {}),
    })),
    explanation: `Auto-populated from skill "${skillName}" plan template.`,
    ...(droppedDuplicates.length > 0 ? { droppedDuplicates } : {}),
    ...(truncated ? { truncated: true } : {}),
    maxSteps,
  };
}

/**
 * Checks whether a skill entry has a non-empty plan template.
 */
export function hasSkillPlanTemplate(metadata?: {
  planTemplate?: SkillPlanTemplateStep[];
}): boolean {
  return Array.isArray(metadata?.planTemplate) && metadata.planTemplate.length > 0;
}
