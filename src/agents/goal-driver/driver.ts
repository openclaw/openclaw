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
};

export type GoalDriverEvent =
  | { kind: "armed"; sessionKey: string; delayMs: number }
  | { kind: "fired"; sessionKey: string; continuationTurns: number }
  | {
      kind: "rearmed";
      sessionKey: string;
      reason: "active-run" | "queue-nonempty";
      delayMs: number;
    }
  | { kind: "disarmed"; sessionKey: string; reason: "goal-inactive" | "no-goal" | "stopped" }
  | { kind: "paused"; sessionKey: string; continuationTurns: number };

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

  /** g1 + prompt source: current durable goal snapshot, or undefined if none. */
  readGoal: (sessionKey: string) => GoalDriverGoalSnapshot | undefined;
  /** g2: a Control-UI-visible run is active for the session. */
  hasActiveRun: (sessionKey: string) => boolean;
  /** g3: inbound queue (queued chat turns / pending system events) is empty. */
  isInboundQueueEmpty: (sessionKey: string) => boolean;

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

  const attemptContinuation = (sessionKey: string) => {
    if (stopped) {
      return;
    }
    const goal = deps.readGoal(sessionKey);
    // g1: no goal, or goal no longer active -> disarm permanently (until the
    // next onTurnCompleted / rearmActiveGoals re-arms it).
    if (!goal) {
      emit({ kind: "disarmed", sessionKey, reason: "no-goal" });
      return;
    }
    if (goal.status !== "active") {
      emit({ kind: "disarmed", sessionKey, reason: "goal-inactive" });
      return;
    }
    // g4: consecutive-continuation ceiling -> auto-pause (terminal until user resume).
    if (goal.continuationTurns >= maxConsecutive) {
      deps.pauseGoal(sessionKey, AUTO_PAUSE_NOTE);
      emit({ kind: "paused", sessionKey, continuationTurns: goal.continuationTurns });
      log?.info(
        { sessionKey, continuationTurns: goal.continuationTurns },
        "goal-driver: auto-paused goal after continuation ceiling",
      );
      return;
    }
    // g2: an active run owns the session -> re-arm at the floor and re-check later.
    if (deps.hasActiveRun(sessionKey)) {
      const delayMs = arm(sessionKey, minRearmGapMs);
      emit({ kind: "rearmed", sessionKey, reason: "active-run", delayMs });
      return;
    }
    // g3: inbound work pending -> let the real turn drain it first.
    if (!deps.isInboundQueueEmpty(sessionKey)) {
      const delayMs = arm(sessionKey, minRearmGapMs);
      emit({ kind: "rearmed", sessionKey, reason: "queue-nonempty", delayMs });
      return;
    }
    // All gates pass -> FIRE. Do NOT re-arm here: the next arm comes from
    // onTurnCompleted when the fired continuation turn finishes, which bounds
    // the fire cadence to >= debounceMs and breaks any tight loop.
    const prompt = deps.buildContinuationPrompt(goal);
    deps.recordContinuation(sessionKey);
    deps.fireContinuation(sessionKey, prompt);
    emit({ kind: "fired", sessionKey, continuationTurns: goal.continuationTurns + 1 });
    log?.debug(
      { sessionKey, continuationTurns: goal.continuationTurns + 1 },
      "goal-driver: fired continuation",
    );
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
