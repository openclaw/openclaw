/**
 * GoalContinuationDriver — a debounced per-session scheduler that autonomously
 * continues an `active` session goal by enqueuing a system-event turn.
 *
 * WHY A DEBOUNCED SCHEDULER, NOT TURN-END REENTRY:
 * OpenClaw has no idle event, and re-entering from a turn's own completion is a
 * tight-loop trap (see `src/cron/service.armtimer-tight-loop.test.ts`). Instead
 * this driver arms a timer N seconds AFTER a turn completes; on wake it must
 * pass four gates or it re-arms (or disarms) without firing. Firing routes
 * through the same `enqueueSystemEvent` + heartbeat-wake path the cron system
 * uses to start a turn in a live session with no inbound message.
 *
 * The four gates (mirroring the dispatch spec):
 *   g1  goal status still `active`     — terminal/paused/limited statuses disarm.
 *   g2  no active run for the session  — wraps resolveVisibleActiveSessionRunState.
 *   g3  inbound queue empty            — wraps listQueuedChatTurnsForSession + system-events.
 *   g4  not stuck in no-progress loop  — goal.continuationTurns < ceiling, else auto-pause.
 *
 * Anti-tight-loop discipline:
 *   - After a successful FIRE the driver does NOT re-arm; the next arm comes only
 *     when the fired turn completes (via onTurnCompleted). Minimum spacing between
 *     fires is therefore >= debounceMs + turn duration.
 *   - A gate-failed wake re-arms at a floor (minRearmGapMs, default 2s) so a busy
 *     session polls at a bounded cadence — never a setTimeout(0) spin.
 *   - arm() is idempotent per session (clears any pending timer first), so restart
 *     re-arm cannot double-fire.
 */

import {
  GOAL_DRIVER_CONTINUATION_MARKER,
  type GoalContinuationContract,
} from "./continuation-prompt.js";

export type GoalDriverLogger = {
  debug: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
};

/** Durable goal snapshot the driver reads to evaluate gates and build prompts. */
export type GoalDriverGoalSnapshot = {
  status: "active" | "paused" | "blocked" | "usage_limited" | "budget_limited" | "complete";
  objective: string;
  tokensUsed: number;
  tokenBudget?: number;
  /** Consecutive driver-fired continuations with no intervening inbound turn. */
  continuationTurns: number;
  /** Optional completion contract restated on every continuation turn. */
  contract?: GoalContinuationContract;
  /** Wait barrier: park until this wall-clock epoch (ms) passes. */
  waitingUntil?: number;
  /** Wait barrier: park until this session key's run ends. */
  waitingOnSessionKey?: string;
};

/**
 * Verdict from the optional goal-completion judge (config-gated, default off).
 *
 *  - `done`     — the objective is verifiably complete; mark the goal complete.
 *  - `continue` — not done; fire the continuation as usual.
 *  - `wait`     — blocked on async work; park behind a time barrier for
 *                 `seconds` (falls back to a default backoff when unset).
 *
 * The judge is deliberately fail-open: an undefined return (or any thrown
 * error) is treated as `continue` so a broken judge never wedges progress.
 */
export type GoalJudgeVerdict =
  | { verdict: "done"; reason?: string }
  | { verdict: "continue"; reason?: string }
  | { verdict: "wait"; reason?: string; seconds?: number };

/**
 * Bounded judge callback. Given the session key and the current goal snapshot,
 * returns a verdict (or undefined to fall through to `continue`). The
 * implementation owns gathering the last response and calling the model; the
 * driver only sequences the verdict against its gates.
 */
export type GoalJudge = (
  sessionKey: string,
  goal: GoalDriverGoalSnapshot,
) => Promise<GoalJudgeVerdict | undefined>;

export type GoalDriverEvent =
  | { kind: "armed"; sessionKey: string; delayMs: number }
  | { kind: "fired"; sessionKey: string; continuationTurns: number }
  | {
      kind: "rearmed";
      sessionKey: string;
      reason: "active-run" | "queue-nonempty" | "wait-barrier";
      delayMs: number;
    }
  | { kind: "disarmed"; sessionKey: string; reason: "goal-inactive" | "no-goal" | "stopped" }
  | { kind: "paused"; sessionKey: string; continuationTurns: number }
  | { kind: "judged"; sessionKey: string; verdict: "done" | "continue" | "wait" }
  | { kind: "completed"; sessionKey: string; reason: "judge-done" };

export type GoalContinuationDriverDeps = {
  log?: GoalDriverLogger;
  /** Debounce after a turn completes before a continuation may fire (default 20s). */
  debounceMs?: number;
  /** Extra random delay in [0, jitterMs) added to each arm (default 5s). */
  jitterMs?: number;
  /** Deterministic RNG in [0,1) for jitter; injected in tests (default Math.random). */
  random?: () => number;
  /** Consecutive no-progress continuations before auto-pause (default 3). */
  maxConsecutiveContinuations?: number;
  /** Floor between re-arms so a failed gate can never tight-loop (default 2s). */
  minRearmGapMs?: number;
  /** Wall-clock source for the time wait-barrier; injected in tests (default Date.now). */
  now?: () => number;

  /** g1 + prompt source: current durable goal snapshot, or undefined if none. */
  readGoal: (sessionKey: string) => GoalDriverGoalSnapshot | undefined;
  /** g2: a Control-UI-visible run is active for the session. */
  hasActiveRun: (sessionKey: string) => boolean;
  /** g3: inbound queue (queued chat turns / pending system events) is empty. */
  isInboundQueueEmpty: (sessionKey: string) => boolean;
  /**
   * g5 (session wait barrier): true while the session named by
   * `waitingOnSessionKey` still has a run in flight. Optional — omitting it
   * makes a session barrier resolve immediately (treated as satisfied).
   */
  isWaitedSessionActive?: (sessionKey: string) => boolean;
  /** g5: clear a satisfied wait barrier so the next wake resumes normal gating. */
  clearWaitBarrier?: (sessionKey: string) => void;

  /** FIRE: enqueue the continuation steering prompt and wake a new turn. */
  fireContinuation: (sessionKey: string, prompt: string) => void;
  /** Build the continuation steering prompt from the current goal snapshot. */
  buildContinuationPrompt: (goal: GoalDriverGoalSnapshot) => string;
  /** Persist an incremented continuationTurns count after a fire. */
  recordContinuation: (sessionKey: string) => void;
  /** Reset continuationTurns to 0 after a real inbound (non-continuation) turn. */
  resetContinuations: (sessionKey: string) => void;
  /** Auto-pause the goal when the no-progress ceiling is hit. */
  pauseGoal: (sessionKey: string, note: string) => void;

  /**
   * Optional bounded completion judge (config-gated). Runs after every gate
   * passes, before a continuation fires. Absent (default) → the driver fires
   * every continuation exactly as before.
   */
  judgeGoal?: GoalJudge;
  /** Mark the goal complete when the judge returns `done`. */
  markGoalComplete?: (sessionKey: string, reason?: string) => void;
  /** Park the goal behind a time barrier when the judge returns `wait`. */
  setWaitBarrier?: (sessionKey: string, params: { seconds?: number; reason?: string }) => void;

  onEvent?: (evt: GoalDriverEvent) => void;
};

const DEFAULT_DEBOUNCE_MS = 20_000;
const DEFAULT_JITTER_MS = 5_000;
const DEFAULT_MAX_CONSECUTIVE = 3;
/** Matches the cron scheduler's MIN_REFIRE_GAP_MS floor (src/cron/service/timer.ts). */
const DEFAULT_MIN_REARM_GAP_MS = 2_000;

const AUTO_PAUSE_NOTE = `Auto-paused: reached the consecutive goal-continuation ceiling without progress. Resume with /goal resume to continue.`;

export type GoalContinuationDriver = {
  /**
   * Arm the debounce after a turn completes for a session.
   * `turnWasGoalContinuation` — true when the completed turn's input was a
   * driver-generated continuation. A false value (a real inbound turn) resets
   * the no-progress ceiling counter before re-arming.
   */
  onTurnCompleted: (params: { sessionKey: string; turnWasGoalContinuation: boolean }) => void;
  /** Re-arm the debounce for sessions with a persisted active goal (gateway restart). */
  rearmActiveGoals: (sessionKeys: Iterable<string>) => void;
  /** Number of sessions with a pending timer (test/introspection helper). */
  pendingCount: () => number;
  /** Cancel every pending timer. */
  stop: () => void;
};

export function createGoalContinuationDriver(
  deps: GoalContinuationDriverDeps,
): GoalContinuationDriver {
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const jitterMs = deps.jitterMs ?? DEFAULT_JITTER_MS;
  const random = deps.random ?? Math.random;
  const maxConsecutive = deps.maxConsecutiveContinuations ?? DEFAULT_MAX_CONSECUTIVE;
  const minRearmGapMs = deps.minRearmGapMs ?? DEFAULT_MIN_REARM_GAP_MS;
  const now = deps.now ?? Date.now;
  const log = deps.log;

  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let stopped = false;

  const emit = (evt: GoalDriverEvent) => {
    try {
      deps.onEvent?.(evt);
    } catch (err) {
      log?.warn({ err: String(err), kind: evt.kind }, "goal-driver: onEvent handler failed");
    }
  };

  const clearTimer = (sessionKey: string) => {
    const timer = timers.get(sessionKey);
    if (timer) {
      clearTimeout(timer);
      timers.delete(sessionKey);
    }
  };

  const resolveDelay = (requestedMs: number): number => {
    const floored = Math.max(requestedMs, minRearmGapMs);
    const jitter = jitterMs > 0 ? Math.floor(random() * jitterMs) : 0;
    return floored + jitter;
  };

  const arm = (sessionKey: string, requestedMs: number): number => {
    // Idempotent: clearing any existing timer first is what makes a double
    // rearmActiveGoals() call (or a restart re-arm racing a live arm) safe.
    clearTimer(sessionKey);
    if (stopped) {
      return 0;
    }
    const delayMs = resolveDelay(requestedMs);
    const timer = setTimeout(() => {
      timers.delete(sessionKey);
      attemptContinuation(sessionKey);
    }, delayMs);
    timers.set(sessionKey, timer);
    return delayMs;
  };

  /**
   * Evaluate a goal's wait barrier (g5): "active" while the barrier holds,
   * "clear" when a set barrier is now satisfied (should be cleared before
   * resuming), or "none" when no barrier is set. A time barrier holds until its
   * deadline; a session barrier holds while the watched session's run is active.
   */
  const evaluateWaitBarrier = (goal: GoalDriverGoalSnapshot): "active" | "clear" | "none" => {
    if (goal.waitingOnSessionKey) {
      const stillActive = deps.isWaitedSessionActive?.(goal.waitingOnSessionKey) ?? false;
      return stillActive ? "active" : "clear";
    }
    if (typeof goal.waitingUntil === "number") {
      return now() < goal.waitingUntil ? "active" : "clear";
    }
    return "none";
  };

  /**
   * The action the pre-fire gates dictate for a session. A `fire` outcome means
   * every gate (g1-g5) currently passes; any other outcome is a deferral the
   * caller must apply via {@link applyNonFireOutcome}.
   */
  type GateOutcome =
    | { kind: "disarm"; reason: "no-goal" | "goal-inactive" }
    | { kind: "rearm"; reason: "wait-barrier" | "active-run" | "queue-nonempty" }
    | { kind: "pause"; continuationTurns: number }
    | { kind: "fire"; goal: GoalDriverGoalSnapshot };

  /**
   * Evaluate the pre-fire gates (g1-g5) against the CURRENT durable goal state.
   * Shared by the timer callback and the post-judge re-check so both honor the
   * same invariants. A satisfied wait barrier is cleared here as a side effect
   * (matching the original inline behavior); the call is otherwise a pure read,
   * so re-evaluating after the async judge is safe and idempotent.
   */
  const evaluateGates = (sessionKey: string): GateOutcome => {
    const goal = deps.readGoal(sessionKey);
    // g1: no goal, or goal no longer active.
    if (!goal) {
      return { kind: "disarm", reason: "no-goal" };
    }
    if (goal.status !== "active") {
      return { kind: "disarm", reason: "goal-inactive" };
    }
    // g5: wait barrier. A parked goal (time deadline not passed, or watched
    // session's run still in flight) must NOT fire and must NOT consume a
    // no-progress turn. A satisfied barrier is cleared so the next wake resumes
    // normal gating.
    const barrier = evaluateWaitBarrier(goal);
    if (barrier === "active") {
      return { kind: "rearm", reason: "wait-barrier" };
    }
    if (barrier === "clear") {
      deps.clearWaitBarrier?.(sessionKey);
    }
    // g4: consecutive-continuation ceiling -> auto-pause (terminal until resume).
    if (goal.continuationTurns >= maxConsecutive) {
      return { kind: "pause", continuationTurns: goal.continuationTurns };
    }
    // g2: an active run owns the session -> re-arm at the floor and re-check later.
    if (deps.hasActiveRun(sessionKey)) {
      return { kind: "rearm", reason: "active-run" };
    }
    // g3: inbound work pending -> let the real turn drain it first.
    if (!deps.isInboundQueueEmpty(sessionKey)) {
      return { kind: "rearm", reason: "queue-nonempty" };
    }
    return { kind: "fire", goal };
  };

  /**
   * Apply a non-fire gate outcome: disarm permanently (until the next
   * onTurnCompleted / rearmActiveGoals), re-arm at the floor, or auto-pause.
   */
  const applyNonFireOutcome = (
    sessionKey: string,
    outcome: Exclude<GateOutcome, { kind: "fire" }>,
  ) => {
    switch (outcome.kind) {
      case "disarm":
        emit({ kind: "disarmed", sessionKey, reason: outcome.reason });
        return;
      case "rearm": {
        const delayMs = arm(sessionKey, minRearmGapMs);
        emit({ kind: "rearmed", sessionKey, reason: outcome.reason, delayMs });
        return;
      }
      case "pause":
        deps.pauseGoal(sessionKey, AUTO_PAUSE_NOTE);
        emit({ kind: "paused", sessionKey, continuationTurns: outcome.continuationTurns });
        log?.info(
          { sessionKey, continuationTurns: outcome.continuationTurns },
          "goal-driver: auto-paused goal after continuation ceiling",
        );
        return;
    }
  };

  const attemptContinuation = (sessionKey: string) => {
    if (stopped) {
      return;
    }
    const outcome = evaluateGates(sessionKey);
    if (outcome.kind !== "fire") {
      applyNonFireOutcome(sessionKey, outcome);
      return;
    }
    // All gates pass. When a completion judge is configured, consult it before
    // firing; otherwise fire directly. The judge branch is async but follows the
    // same no-re-arm invariant: the next arm only comes from onTurnCompleted.
    if (deps.judgeGoal) {
      void runJudgedContinuation(sessionKey, outcome.goal);
      return;
    }
    fireNow(sessionKey, outcome.goal);
  };

  /**
   * FIRE. Do NOT re-arm here: the next arm comes from onTurnCompleted when the
   * fired continuation turn finishes, which bounds the fire cadence to
   * >= debounceMs and breaks any tight loop.
   */
  const fireNow = (sessionKey: string, goal: GoalDriverGoalSnapshot) => {
    const prompt = deps.buildContinuationPrompt(goal);
    deps.recordContinuation(sessionKey);
    deps.fireContinuation(sessionKey, prompt);
    emit({ kind: "fired", sessionKey, continuationTurns: goal.continuationTurns + 1 });
    log?.debug(
      { sessionKey, continuationTurns: goal.continuationTurns + 1 },
      "goal-driver: fired continuation",
    );
  };

  /**
   * Run the completion judge, then act on its verdict:
   *   done     -> mark the goal complete; no continuation fires.
   *   wait     -> park behind a time barrier; no continuation fires.
   *   continue -> fire the continuation as usual.
   * Fail-open: an undefined verdict (or a thrown judge) fires normally.
   *
   * The judge await opens a gap after the pre-fire gates passed, so state may
   * have changed mid-judge (a user turn queued, the goal paused/blocked/
   * completed, a run started). Before acting we re-evaluate the gates:
   *   - continue/fail-open re-checks EVERY gate before firing — a flipped gate
   *     re-arms or disarms exactly as the synchronous path would, never firing
   *     blindly into a session that now has queued work.
   *   - done/wait proceed only while the goal is still live; a goal the user
   *     deactivated mid-judge disarms without mutating. The durable store
   *     mutations guard too (defense in depth), but skipping here avoids a
   *     misleading judged/completed event.
   */
  const runJudgedContinuation = async (sessionKey: string, goal: GoalDriverGoalSnapshot) => {
    let verdict: GoalJudgeVerdict | undefined;
    try {
      verdict = await deps.judgeGoal?.(sessionKey, goal);
    } catch (err) {
      log?.warn({ err: String(err), sessionKey }, "goal-driver: judge threw; firing continuation");
      verdict = undefined;
    }
    if (stopped) {
      return;
    }
    const outcome = evaluateGates(sessionKey);
    if (verdict?.verdict === "done") {
      if (outcome.kind === "disarm") {
        applyNonFireOutcome(sessionKey, outcome);
        return;
      }
      deps.markGoalComplete?.(sessionKey, verdict.reason);
      emit({ kind: "judged", sessionKey, verdict: "done" });
      emit({ kind: "completed", sessionKey, reason: "judge-done" });
      log?.info({ sessionKey }, "goal-driver: judge marked goal complete");
      return;
    }
    if (verdict?.verdict === "wait") {
      if (outcome.kind === "disarm") {
        applyNonFireOutcome(sessionKey, outcome);
        return;
      }
      deps.setWaitBarrier?.(sessionKey, {
        ...(verdict.seconds !== undefined ? { seconds: verdict.seconds } : {}),
        ...(verdict.reason ? { reason: verdict.reason } : {}),
      });
      emit({ kind: "judged", sessionKey, verdict: "wait" });
      log?.info({ sessionKey }, "goal-driver: judge parked goal on a wait barrier");
      return;
    }
    emit({ kind: "judged", sessionKey, verdict: "continue" });
    if (outcome.kind === "fire") {
      fireNow(sessionKey, outcome.goal);
      return;
    }
    applyNonFireOutcome(sessionKey, outcome);
  };

  const onTurnCompleted: GoalContinuationDriver["onTurnCompleted"] = ({
    sessionKey,
    turnWasGoalContinuation,
  }) => {
    if (stopped) {
      return;
    }
    const goal = deps.readGoal(sessionKey);
    if (!goal || goal.status !== "active") {
      // Goal ended (or the model marked it complete/blocked this turn) -> disarm.
      clearTimer(sessionKey);
      return;
    }
    if (!turnWasGoalContinuation) {
      // A real inbound turn is progress: reset the no-progress ceiling counter.
      deps.resetContinuations(sessionKey);
    }
    const delayMs = arm(sessionKey, debounceMs);
    emit({ kind: "armed", sessionKey, delayMs });
  };

  const rearmActiveGoals: GoalContinuationDriver["rearmActiveGoals"] = (sessionKeys) => {
    if (stopped) {
      return;
    }
    for (const sessionKey of sessionKeys) {
      const goal = deps.readGoal(sessionKey);
      if (!goal || goal.status !== "active") {
        continue;
      }
      const delayMs = arm(sessionKey, debounceMs);
      emit({ kind: "armed", sessionKey, delayMs });
    }
  };

  return {
    onTurnCompleted,
    rearmActiveGoals,
    pendingCount: () => timers.size,
    stop: () => {
      stopped = true;
      for (const [sessionKey, timer] of timers) {
        clearTimeout(timer);
        emit({ kind: "disarmed", sessionKey, reason: "stopped" });
      }
      timers.clear();
    },
  };
}

/** Re-exported so wiring code and tests share the marker without a deep import. */
export { GOAL_DRIVER_CONTINUATION_MARKER };
