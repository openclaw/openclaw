import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { type AgentPlanEventData, emitAgentPlanEvent } from "../../infra/agent-events.js";
import { logWarn } from "../../logger.js";
import { loadWorkspaceSkillEntries, type SkillEntry, type SkillSnapshot } from "../skills.js";
import { shouldIncludeSkill } from "../skills/config.js";
import { resolveSkillRuntimeConfig } from "../skills/runtime-config.js";
import {
  buildPlanTemplatePayload,
  hasSkillPlanTemplate,
  type PlanTemplatePayload,
} from "../skills/skill-planner.js";
import type { SkillPlanTemplateStep } from "../skills/types.js";

export function resolveEmbeddedRunSkillEntries(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  agentId?: string;
  skillsSnapshot?: SkillSnapshot;
}): {
  shouldLoadSkillEntries: boolean;
  skillEntries: SkillEntry[];
} {
  // PR-E review fix (Codex P2 #3096508609): also reload entries when the
  // snapshot is from a session that predates `resolvedPlanTemplates`.
  // `resolvedPlanTemplates === undefined` (vs empty array) signals an
  // older snapshot that was built before the field existed; without
  // this fallback the seed silently no-ops for those sessions because
  // entries would be empty AND the snapshot would have no templates to
  // fall back on. Empty array is treated as "no templates, trust the
  // snapshot" so no unnecessary reload fires for new snapshots that
  // genuinely have no templates.
  const snapshot = params.skillsSnapshot;
  const snapshotIsOldVersion =
    snapshot !== undefined &&
    snapshot.resolvedSkills !== undefined &&
    snapshot.resolvedPlanTemplates === undefined;
  const shouldLoadSkillEntries = !snapshot || !snapshot.resolvedSkills || snapshotIsOldVersion;
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
  // Codex P2 (PR #67541 r3096399074): apply eligibility filtering BEFORE
  // collision resolution. `loadWorkspaceSkillEntries` returns every loaded
  // skill (including disabled / missing-env / wrong-OS ones) when no
  // explicit `skillFilter` is set; without this guard a disabled skill
  // could win the alpha-first collision and seed an unrelated plan that
  // never appears in the runtime prompt.
  //
  // PR-E review fix (Copilot #3105043886): use the resolved (runtime)
  // config for the eligibility filter so it matches what
  // `loadWorkspaceSkillEntries` used at load time. Otherwise a runtime
  // snapshot's overrides could disagree with the static config and a
  // skill that's runtime-disabled could still win seeding.
  const resolvedConfig = resolveSkillRuntimeConfig(config);
  const eligibleEntries = entries.filter((entry) =>
    shouldIncludeSkill({ entry, config: resolvedConfig }),
  );
  // PR-E review fix (Copilot #3096799707): the `hasSkillPlanTemplate`
  // guard already proves `e.metadata.planTemplate` is a non-empty array,
  // so the prior follow-up null-check on `winnerTemplate` was dead
  // code. Removed; the candidates filter alone is sufficient.
  const candidates = eligibleEntries
    .filter((e) => hasSkillPlanTemplate(e.metadata))
    .toSorted((a, b) => a.skill.name.localeCompare(b.skill.name));

  if (candidates.length === 0) {
    return null;
  }

  return resolveSkillPlanTemplateFromCandidates(
    candidates.map((c) => ({
      skillName: c.skill.name,
      // Safe non-null assertion: `hasSkillPlanTemplate` guarantees the
      // array is present and non-empty, but TypeScript can't narrow
      // through the function call.
      planTemplate: c.metadata!.planTemplate!,
    })),
    config,
  );
}

/**
 * Lower-level resolver that operates on the snapshot's
 * `resolvedPlanTemplates` shape — name + template list, without the
 * full SkillEntry. Used in the snapshot-backed run path where
 * `resolveEmbeddedRunSkillEntries` returns no entries.
 *
 * PR-E review fix (Copilot #3096524276 / #3105170512): docstring
 * previously said "this function does not re-sort", but the
 * implementation DOES call `.toSorted(...)` on candidates as a
 * defensive guarantee against caller-side ordering bugs. Updated to
 * match: candidates are re-sorted alphabetically by `skillName` before
 * collision resolution so deterministic behavior holds regardless of
 * caller-side ordering. The cost (one extra sort over a typically
 * small array) is negligible vs the safety win.
 */
export function resolveSkillPlanTemplateFromCandidates(
  candidates: ReadonlyArray<{ skillName: string; planTemplate: SkillPlanTemplateStep[] }>,
  config?: OpenClawConfig,
): SkillPlanTemplateResolution | null {
  const filtered = candidates
    .filter((c) => Array.isArray(c.planTemplate) && c.planTemplate.length > 0)
    .toSorted((a, b) => a.skillName.localeCompare(b.skillName));
  if (filtered.length === 0) {
    return null;
  }
  const winner = filtered[0];
  const maxSteps = config?.skills?.limits?.maxPlanTemplateSteps;
  const payload =
    maxSteps && maxSteps > 0
      ? buildPlanTemplatePayload(winner.skillName, winner.planTemplate, { maxSteps })
      : buildPlanTemplatePayload(winner.skillName, winner.planTemplate);
  if (!payload) {
    return null;
  }
  return {
    payload,
    skillName: winner.skillName,
    rejected: filtered.slice(1).map((c) => c.skillName),
  };
}

export interface ApplySkillPlanTemplateSeedParams {
  /**
   * Loaded skill entries for this run. May be empty in the
   * snapshot-backed run path; see `skillsSnapshot` below.
   */
  entries: SkillEntry[];
  /**
   * Optional pre-built snapshot. When `entries` is empty (the main
   * run path uses a snapshot built by `buildWorkspaceSkillSnapshot`
   * and skips re-loading entries), the seeder falls back to the
   * snapshot's `resolvedPlanTemplates` so the seed still fires.
   */
  skillsSnapshot?: SkillSnapshot;
  /** Stable run identifier used to scope the emitted plan event. */
  runId?: string;
  /** Session key for control UI / channel routing. */
  sessionKey?: string;
  /** Resolved config — used for `skills.limits.maxPlanTemplateSteps`. */
  config?: OpenClawConfig;
  /**
   * Run-scoped event callback used by some consumers (e.g. the auto-reply
   * pipeline at `src/auto-reply/reply/agent-runner-execution.ts`) to
   * receive plan updates. Codex P2 (PR #67541 r3096399082/r3096435183) —
   * other plan-update sites call BOTH `emitAgentPlanEvent` and this
   * callback; the seeder must too, or callback-only consumers miss the
   * initial seed event.
   */
  onAgentEvent?: (evt: { stream: "plan"; data: AgentPlanEventData }) => void;
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
  // Snapshot fallback: when entries are empty (main snapshot-backed path),
  // use the templates baked into the snapshot at build time. Otherwise the
  // seed silently no-ops in production runs that supply a snapshot.
  let resolution = resolveSkillPlanTemplate(params.entries, params.config);
  if (!resolution) {
    const snapshotTemplates = params.skillsSnapshot?.resolvedPlanTemplates;
    if (snapshotTemplates && snapshotTemplates.length > 0) {
      resolution = resolveSkillPlanTemplateFromCandidates(snapshotTemplates, params.config);
    }
  }
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

  const planEventData: AgentPlanEventData = {
    phase: "update",
    title: `Plan seeded from skill "${skillName}"`,
    explanation: payload.explanation,
    steps: payload.plan.map((s) => s.step),
    source: "skill_plan_template",
  };

  // Forward to the run-scoped callback FIRST so callback-only consumers
  // (e.g. the auto-reply pipeline) don't miss the seed. Other plan-update
  // sites in run.ts call BOTH paths — the seed must too.
  // (Codex P2 #67541 r3096399082 / r3096435183)
  try {
    params.onAgentEvent?.({ stream: "plan", data: planEventData });
  } catch (err) {
    // Don't let a callback throw block the global emit.
    logWarn(
      `onAgentEvent callback threw during skill plan seed: ${(err as Error)?.message ?? err}`,
    );
  }

  emitAgentPlanEvent({
    runId: params.runId,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    data: planEventData,
  });

  return {
    skillName,
    emittedSteps: payload.plan.length,
    rejected,
    droppedDuplicates,
    truncated,
  };
}
