/**
 * PR #68939 follow-up (P2.9) — execution-phase plan nudges.
 *
 * Sibling to `plan-nudge-crons.ts`. The design-phase nudges (10/30/60
 * min) push an agent that's stalled while DESIGNING a plan (before
 * exit_plan_mode lands). Once the plan is approved and the session
 * transitions to `mode: "executing"`, those design-phase nudges are
 * irrelevant — the agent should be advancing approved steps, not
 * re-thinking the plan.
 *
 * Execution-phase nudges fire at TIGHTER intervals (1/3/5 min by
 * default) targeting the most-recent `in_progress` step. The message
 * body is intentionally narrow ("call update_plan to mark the current
 * step done if it's complete, or report what you're stuck on" rather
 * than "advance the next step") so the agent's response stays focused
 * on completing the approved plan rather than re-planning.
 *
 * Scheduling: fired by sessions-patch.ts on the approve transition
 * (mode → executing), the same handoff that cleans up the
 * design-phase nudges. The job IDs are persisted on
 * `SessionEntry.planMode.executionNudgeJobIds` so cleanup at
 * close-on-complete can target them precisely (parallel to the
 * existing `nudgeJobIds` design-phase tracking).
 *
 * Cron-fire-time guard: lives in `cron/isolated-agent/run.ts`. Skips
 * the nudge when:
 *   - `livePlanMode.mode !== "executing"` (close-on-complete fired
 *     OR /plan off OR mode reset by another path)
 *   - `livePlanMode.cycleId !== payload.executionCycleId` (this cron
 *     belongs to a previous executing cycle)
 *   - all `lastPlanSteps` are completed/cancelled (close-on-complete
 *     about to fire, race window — skip the nudge to avoid waking
 *     the agent right before auto-close)
 *
 * Cleanup: `cleanupPlanExecutionNudges` is called on close-on-complete
 * + sessions-patch close-path (parallel to `cleanupPlanNudges`).
 * Best-effort failures degrade to no-op (the leftover crons fire into
 * a normal-mode session and the cron guard skips them).
 */
import { callGatewayTool } from "../tools/gateway.js";

/**
 * Default execution-phase nudge intervals (minutes). Tighter than the
 * design-phase 10/30/60 because execution stalls (subagent return
 * not noticed, step status not updated, etc.) are typically resolved
 * within a few minutes of attention; longer intervals just delay
 * recovery.
 */
const DEFAULT_EXECUTION_NUDGE_MINUTES = [1, 3, 5] as const;

/** Marker prefix so cleanup + telemetry can identify these crons. */
const PLAN_EXECUTION_NUDGE_NAME_PREFIX = "plan-execution-nudge:";

export interface PlanExecutionNudgeSchedulerDeps {
  /**
   * Test injection point for the gateway round-trip. Defaults to
   * `callGatewayTool`. Mirrors `PlanNudgeSchedulerDeps`.
   */
  callGatewayTool?: (method: string, opts: object, params: unknown) => Promise<unknown>;
  /** Override Date.now() for deterministic tests. */
  now?: () => number;
}

export interface ScheduledPlanExecutionNudge {
  jobId: string;
  fireAtMs: number;
}

/**
 * Schedule one-shot execution-phase nudge crons for a session that
 * just transitioned to `mode: "executing"`. Returns the created job
 * ids so the caller can persist them on
 * `SessionEntry.planMode.executionNudgeJobIds`.
 *
 * Scheduling failures for individual nudges are tolerated (return the
 * partial-success list rather than throwing), matching the
 * design-phase scheduler's contract.
 */
export async function schedulePlanExecutionNudges(params: {
  sessionKey: string;
  agentId?: string;
  /**
   * The cycleId of the executing plan (mirrors the `planCycleId` field
   * on the design-phase scheduler). Used by the cron-fire-time guard
   * to reject nudges that fired AFTER a new cycle started.
   */
  executionCycleId?: string;
  intervals?: ReadonlyArray<number>;
  deps?: PlanExecutionNudgeSchedulerDeps;
  log?: { warn?: (msg: string) => void; info?: (msg: string) => void };
}): Promise<ScheduledPlanExecutionNudge[]> {
  const intervals = params.intervals ?? DEFAULT_EXECUTION_NUDGE_MINUTES;
  const now = params.deps?.now?.() ?? Date.now();
  const call = params.deps?.callGatewayTool ?? callGatewayTool;
  const scheduled: ScheduledPlanExecutionNudge[] = [];
  for (const minutes of intervals) {
    if (minutes <= 0 || !Number.isFinite(minutes)) {
      continue;
    }
    const fireAtMs = now + Math.floor(minutes * 60_000);
    const fireAtIso = new Date(fireAtMs).toISOString();
    try {
      // Execution-phase nudge body — narrower than the design-phase
      // wake-up. Tells the agent specifically to record step status
      // (the most-common stall) rather than re-plan. Mirrors the
      // approved-plan injection text added in commit 9bf283be71
      // (which addressed Eva's "subagent returned but plan not
      // marked complete" stall).
      //
      // P2.12a (2026-04-22): restructured as imperative steps so
      // GPT-5.4 cannot shortcut to NO_REPLY on a belief that it
      // "already knows" the plan is done. Live-validated failure
      // mode: agent received the +1/+3/+5 nudges, believed
      // internally that "all steps are marked complete", returned
      // NO_REPLY three times — but `plan_mode_status` showed 1
      // in_progress + 3 pending + 2 completed. The agent conflated
      // "did the work" with "called update_plan on it".
      //
      // Adversarial review #1 round-2 feedback: the earlier draft's
      // closing sentence "if zero pending+in_progress, no further
      // action needed" was itself an escape hatch — the model could
      // read it as permission to NO_REPLY without calling the tool,
      // reinstating the exact failure mode this nudge tries to
      // break. This revision removes that escape and makes step 1
      // (call plan_mode_status) unconditional.
      const message =
        `[PLAN_NUDGE]: Execution-phase wake-up (+${minutes}min). REQUIRED STEPS: ` +
        "(1) Call `plan_mode_status` to read the authoritative step counts — " +
        "do NOT skip this step even if you believe you already know the answer, " +
        "your internal memory of which steps you marked via update_plan is " +
        "unreliable across turns. " +
        "(2) Based ONLY on what `plan_mode_status` reports: if any step is " +
        "`pending` or `in_progress`, call `update_plan` to mark finished steps " +
        '"completed" / "cancelled" or to advance the next step with work. ' +
        "(3) If you are blocked on an external wait, schedule another resume " +
        "via cron sessionTarget:'current' and explain what you are waiting on. " +
        "(4) If `plan_mode_status` shows zero `pending` and zero `in_progress` " +
        "steps, close-on-complete will fire automatically; you may then return " +
        "a brief completion summary.";
      // Same sessionTarget-validation guardrail as the design-phase
      // scheduler: catch malformed sessionKeys locally instead of
      // letting the cron jobs.ts validator reject ~60s later.
      const { assertSafeCronSessionTargetId } = await import("../../cron/session-target.js");
      try {
        assertSafeCronSessionTargetId(params.sessionKey);
      } catch (validationErr) {
        params.log?.warn?.(
          `plan-execution-nudge schedule skipped: sessionKey "${params.sessionKey}" fails cron sessionTarget validation: ${
            validationErr instanceof Error ? validationErr.message : String(validationErr)
          }`,
        );
        continue;
      }
      const job: Record<string, unknown> = {
        name: `${PLAN_EXECUTION_NUDGE_NAME_PREFIX}${minutes}min:${params.sessionKey}`,
        schedule: { kind: "at", at: fireAtIso },
        sessionTarget: `session:${params.sessionKey}`,
        payload: {
          kind: "agentTurn",
          message,
          // Distinct field from `planCycleId` (design-phase) so the
          // cron-fire-time guard in cron/isolated-agent/run.ts can
          // route the nudge to the right suppression check.
          ...(params.executionCycleId ? { executionCycleId: params.executionCycleId } : {}),
        },
        deleteAfterRun: true,
        delivery: { mode: "none" },
      };
      if (params.agentId) {
        job.agentId = params.agentId;
      }
      const result = await call("cron.add", {}, job);
      const jobId = extractJobId(result);
      if (jobId) {
        scheduled.push({ jobId, fireAtMs });
      } else {
        params.log?.warn?.(
          `plan-execution-nudge schedule succeeded but jobId missing from response: minutes=${minutes}`,
        );
      }
    } catch (err) {
      params.log?.warn?.(
        `plan-execution-nudge schedule failed: sessionKey=${params.sessionKey} minutes=${minutes} err=${String(err)}`,
      );
    }
  }
  if (scheduled.length > 0) {
    params.log?.info?.(
      `plan-execution-nudge crons scheduled: sessionKey=${params.sessionKey} count=${scheduled.length}`,
    );
  }
  return scheduled;
}

/**
 * Best-effort cleanup of previously-scheduled execution-phase nudges.
 * Called on the close-on-complete path + on `/plan off` + on any
 * sessions.patch transition that takes the session out of executing
 * (back to plan, to normal, or deletes planMode).
 */
export async function cleanupPlanExecutionNudges(params: {
  jobIds: ReadonlyArray<string>;
  deps?: PlanExecutionNudgeSchedulerDeps;
  log?: { warn?: (msg: string) => void };
}): Promise<{ removed: number; failed: number }> {
  if (params.jobIds.length === 0) {
    return { removed: 0, failed: 0 };
  }
  const call = params.deps?.callGatewayTool ?? callGatewayTool;
  let removed = 0;
  let failed = 0;
  for (const id of params.jobIds) {
    try {
      await call("cron.remove", {}, { id });
      removed += 1;
    } catch (err) {
      failed += 1;
      params.log?.warn?.(`plan-execution-nudge cleanup failed: id=${id} err=${String(err)}`);
    }
  }
  return { removed, failed };
}

function extractJobId(result: unknown): string | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const r = result as Record<string, unknown>;
  if (typeof r.id === "string") {
    return r.id;
  }
  if (r.job && typeof r.job === "object") {
    const j = r.job as Record<string, unknown>;
    if (typeof j.id === "string") {
      return j.id;
    }
  }
  return undefined;
}

export const PLAN_EXECUTION_NUDGE_NAME_PREFIX_FOR_TEST = PLAN_EXECUTION_NUDGE_NAME_PREFIX;
