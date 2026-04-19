/**
 * PR-9 Wave B3: schedule + clean up "plan nudge" cron jobs.
 *
 * When the agent calls `enter_plan_mode`, the runtime auto-schedules a
 * series of one-shot cron wake-ups bound to the same session. Each
 * wake-up fires a fresh agent turn into the originating session that
 * reads the persisted `SessionEntry.planMode` (mode + lastPlanSteps)
 * and either continues the plan or — if the plan has already been
 * resolved (completed, exited, or rejected) — exits cleanly via the
 * heartbeat pathway (Wave A1's nudge prefix returns null, so a
 * resolved-plan wake-up degrades to a normal heartbeat no-op).
 *
 * Why multiple intervals (10/30/60 min): single-shot reminders miss
 * if the agent is busy at the trigger moment; spaced intervals catch
 * different stall classes (short orchestration pause, longer external
 * wait, abandoned-without-exiting). Each is a one-shot, so they don't
 * accumulate beyond the tracked `nudgeJobIds`.
 *
 * Cleanup: when `exit_plan_mode` resolves OR the close-on-complete
 * persister fires, all stored nudge job ids are removed via
 * `cron.remove`. Best-effort — if cron removal fails, the nudges fire
 * harmlessly into a normal-mode session and degrade to no-op.
 */
import { callGatewayTool } from "../tools/gateway.js";

/** Default nudge intervals (minutes). Overridable via `agents.defaults.planMode.nudgeMinutes`. */
const DEFAULT_NUDGE_MINUTES = [10, 30, 60] as const;

/** Marker string embedded in cron job names so we can recognize / safely cleanup our own nudges. */
const PLAN_NUDGE_NAME_PREFIX = "plan-nudge:";

export interface PlanNudgeSchedulerDeps {
  /**
   * Called by tests to substitute the gateway round-trip. Defaults to
   * the real `callGatewayTool` against the local gateway endpoint when
   * omitted. Signature mirrors `callGatewayTool(method, opts, params)`.
   */
  callGatewayTool?: (method: string, opts: object, params: unknown) => Promise<unknown>;
  /** Override Date.now() for deterministic tests. */
  now?: () => number;
}

export interface ScheduledPlanNudge {
  jobId: string;
  fireAtMs: number;
}

/**
 * Schedule one-shot nudge crons for an active plan-mode session.
 * Returns the created job ids so the caller can persist them on
 * `SessionEntry.planMode.nudgeJobIds` for later cleanup.
 *
 * Scheduling failures for individual nudges are tolerated — we return
 * the partial success list rather than throwing. This keeps
 * `enter_plan_mode` from failing user-visibly when an unrelated cron
 * issue occurs (the plan still works without nudges; they're an
 * augmentation, not core).
 */
export async function schedulePlanNudges(params: {
  sessionKey: string;
  agentId?: string;
  intervals?: ReadonlyArray<number>;
  deps?: PlanNudgeSchedulerDeps;
  log?: { warn?: (msg: string) => void; info?: (msg: string) => void };
}): Promise<ScheduledPlanNudge[]> {
  const intervals = params.intervals ?? DEFAULT_NUDGE_MINUTES;
  const now = params.deps?.now?.() ?? Date.now();
  const call = params.deps?.callGatewayTool ?? callGatewayTool;
  const scheduled: ScheduledPlanNudge[] = [];
  for (const minutes of intervals) {
    if (minutes <= 0 || !Number.isFinite(minutes)) {
      continue;
    }
    const fireAtMs = now + Math.floor(minutes * 60_000);
    const fireAtIso = new Date(fireAtMs).toISOString();
    try {
      // The wake-up message intentionally references plan state by
      // saying "your plan" — when this fires, the resumed agent turn
      // reads SessionEntry.planMode.lastPlanSteps from disk and
      // figures out which step to advance. If plan mode has already
      // been exited / completed by the time this fires, the
      // heartbeat-runner's `buildActivePlanNudge` returns null and
      // the turn degrades to standard heartbeat behavior (no-op).
      // Live-test iteration 1 Bug 1: `[PLAN_NUDGE]:` prefix matches the
      // family of plan-mode synthetic messages so channel renderers
      // can identify + future PRs can hide them from user-visible chat.
      const message =
        `[PLAN_NUDGE]: Plan-nudge wake-up (+${minutes}min): if your plan is still active, ` +
        "advance the next step. If you're blocked on an external wait, schedule " +
        "another resume via cron sessionTarget:'current'. If the plan is " +
        "complete, exit_plan_mode (or update_plan with all steps marked " +
        "completed/cancelled to auto-close).";
      const job: Record<string, unknown> = {
        name: `${PLAN_NUDGE_NAME_PREFIX}${minutes}min:${params.sessionKey}`,
        schedule: { kind: "at", at: fireAtIso },
        sessionTarget: `session:${params.sessionKey}`,
        payload: { kind: "agentTurn", message },
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
          `plan-nudge schedule succeeded but jobId missing from response: minutes=${minutes}`,
        );
      }
    } catch (err) {
      params.log?.warn?.(
        `plan-nudge schedule failed: sessionKey=${params.sessionKey} minutes=${minutes} err=${String(err)}`,
      );
    }
  }
  if (scheduled.length > 0) {
    params.log?.info?.(
      `plan-nudge crons scheduled: sessionKey=${params.sessionKey} count=${scheduled.length}`,
    );
  }
  return scheduled;
}

/**
 * Best-effort cleanup of previously-scheduled nudge crons. Called when
 * the plan resolves (exit_plan_mode, close-on-complete, or session
 * leaves plan mode via user-driven sessions.patch). Failures are
 * logged but not surfaced — the leftover nudges degrade to no-op when
 * they fire into a normal-mode session.
 */
export async function cleanupPlanNudges(params: {
  jobIds: ReadonlyArray<string>;
  deps?: PlanNudgeSchedulerDeps;
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
      params.log?.warn?.(`plan-nudge cleanup failed: id=${id} err=${String(err)}`);
    }
  }
  return { removed, failed };
}

function extractJobId(result: unknown): string | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const r = result as Record<string, unknown>;
  // Try common shapes: { jobId }, { id }, { job: { id } }
  if (typeof r.jobId === "string") {
    return r.jobId;
  }
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

export const PLAN_NUDGE_NAME_PREFIX_FOR_TEST = PLAN_NUDGE_NAME_PREFIX;
