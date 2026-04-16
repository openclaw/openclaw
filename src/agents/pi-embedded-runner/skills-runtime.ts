import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { emitAgentPlanEvent } from "../../infra/agent-events.js";
import { logWarn } from "../../logger.js";
import { loadWorkspaceSkillEntries, type SkillEntry, type SkillSnapshot } from "../skills.js";
import { resolveSkillRuntimeConfig } from "../skills/runtime-config.js";
import {
  buildPlanTemplatePayload,
  hasSkillPlanTemplate,
  type PlanTemplatePayload,
} from "../skills/skill-planner.js";

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
 * Result of resolving the plan template seed for a set of loaded skills.
 *
 * When more than one skill carries a `planTemplate`, the implementation
 * picks the alphabetically-first skill name as the deterministic winner
 * and lists the others in `rejected` so the caller can emit a
 * `skill_plan_template_collision` warning event.
 */
export interface SkillPlanTemplateResolution {
  /** Normalized payload ready to seed into the agent's plan. */
  payload: PlanTemplatePayload;
  /** Skill that won the collision (alpha-sorted first by name). */
  skillName: string;
  /** Skills with templates that were ignored due to the collision. */
  rejected: string[];
}

/**
 * Picks the plan-template payload to seed for this run. Returns `null`
 * when no loaded skill carries a non-empty `planTemplate`.
 *
 * Collision policy: if multiple skills carry templates, the
 * alphabetically-first skill name wins. The remaining skill names are
 * returned in `rejected` so the caller can warn.
 *
 * Upper bound: when `config.skills.limits.maxPlanTemplateSteps` is set,
 * the resolved payload's plan is truncated and `payload.truncated` is
 * `true`.
 */
export function resolveSkillPlanTemplate(
  entries: SkillEntry[],
  config?: OpenClawConfig,
): SkillPlanTemplateResolution | null {
  const candidates = entries
    .filter((e) => hasSkillPlanTemplate(e.metadata) && e.metadata?.planTemplate)
    .toSorted((a, b) => a.skill.name.localeCompare(b.skill.name));

  if (candidates.length === 0) {
    return null;
  }

  const winner = candidates[0];
  const winnerTemplate = winner.metadata?.planTemplate;
  if (!winnerTemplate) {
    return null;
  }

  const maxSteps = config?.skills?.limits?.maxPlanTemplateSteps;
  const payload =
    maxSteps && maxSteps > 0
      ? buildPlanTemplatePayload(winner.skill.name, winnerTemplate, { maxSteps })
      : buildPlanTemplatePayload(winner.skill.name, winnerTemplate);
  if (!payload) {
    return null;
  }

  return {
    payload,
    skillName: winner.skill.name,
    rejected: candidates.slice(1).map((c) => c.skill.name),
  };
}

export interface ApplySkillPlanTemplateSeedParams {
  /** Loaded skill entries for this run. */
  entries: SkillEntry[];
  /** Stable run identifier used to scope the emitted plan event. */
  runId?: string;
  /** Session key for control UI / channel routing. */
  sessionKey?: string;
  /** Resolved config — used for `skills.limits.maxPlanTemplateSteps`. */
  config?: OpenClawConfig;
  /**
   * When provided and non-empty, seeding is skipped. Treats an existing
   * plan as user intent and avoids clobbering it with a stock template.
   * Wired to `AgentRunContext.lastPlanSteps` once #67514 lands.
   */
  existingPlanSteps?: ReadonlyArray<{ step: string }>;
}

export interface AppliedSkillPlanTemplateSeed {
  /** Skill that supplied the seed. */
  skillName: string;
  /** Number of plan steps emitted (post-dedup, post-truncate). */
  emittedSteps: number;
  /** Other skills with templates that were ignored. */
  rejected: string[];
  /** Step texts dropped because they duplicated an earlier entry. */
  droppedDuplicates: string[];
  /** True if the template exceeded the configured upper bound. */
  truncated: boolean;
}

/**
 * Seeds the agent's plan from the activated skills' `planTemplate` (if any).
 *
 * Behavior:
 * - If no candidate skill carries a non-empty template, returns `null`.
 * - If `existingPlanSteps` is non-empty, skips seeding (idempotency).
 * - Otherwise emits an `agent_plan_event` with the template steps and
 *   logs warnings for collision / dropped duplicates / truncation.
 *
 * Returns a summary describing the applied seed (or `null` when no seed
 * was emitted) so callers can write tests / surface telemetry.
 */
export function applySkillPlanTemplateSeed(
  params: ApplySkillPlanTemplateSeedParams,
): AppliedSkillPlanTemplateSeed | null {
  if (!params.runId) {
    return null;
  }
  if (params.existingPlanSteps && params.existingPlanSteps.length > 0) {
    // Existing plan present — treat it as user intent and skip the seed.
    return null;
  }
  const resolution = resolveSkillPlanTemplate(params.entries, params.config);
  if (!resolution) {
    return null;
  }

  const { payload, skillName, rejected } = resolution;
  const droppedDuplicates = payload.droppedDuplicates ?? [];
  const truncated = payload.truncated === true;

  if (rejected.length > 0) {
    logWarn(
      `skill_plan_template_collision: ${rejected.length + 1} loaded skills carry plan templates; using "${skillName}" (alpha-first), ignoring [${rejected.join(", ")}]`,
    );
  }
  if (droppedDuplicates.length > 0) {
    logWarn(
      `skill_plan_template_duplicates: dropped ${droppedDuplicates.length} duplicate step(s) from "${skillName}" template: [${droppedDuplicates.join(", ")}]`,
    );
  }
  if (truncated) {
    logWarn(
      `skill_plan_template_truncated: skill "${skillName}" template exceeded maxPlanTemplateSteps (${payload.maxSteps}); tail dropped`,
    );
  }

  emitAgentPlanEvent({
    runId: params.runId,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    data: {
      phase: "update",
      title: `Plan seeded from skill "${skillName}"`,
      explanation: payload.explanation,
      steps: payload.plan.map((s) => s.step),
      source: "skill_plan_template",
    },
  });

  return {
    skillName,
    emittedSteps: payload.plan.length,
    rejected,
    droppedDuplicates,
    truncated,
  };
}
