// Loop-safety tests for the GoalContinuationDriver. Mirrors the discipline of
// src/cron/service.armtimer-tight-loop.test.ts: fake timers + a setTimeout spy
// prove the driver never schedules a tight loop, honors all four gates, and
// auto-pauses at the consecutive-continuation ceiling.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatGoalDriverContinuationPrompt,
  isGoalDriverContinuationPrompt,
} from "./continuation-prompt.js";
import {
  createGoalContinuationDriver,
  type GoalDriverEvent,
  type GoalDriverGoalSnapshot,
} from "./driver.js";

const DEBOUNCE_MS = 20_000;
const MIN_REARM_GAP_MS = 2_000;

type Harness = ReturnType<typeof createHarness>;

function createHarness(overrides?: {
  debounceMs?: number;
  jitterMs?: number;
  maxConsecutiveContinuations?: number;
}) {
  const goals = new Map<string, GoalDriverGoalSnapshot>();
  const activeRuns = new Set<string>();
  const nonEmptyQueues = new Set<string>();
  const fires: Array<{ sessionKey: string; prompt: string }> = [];
  const events: GoalDriverEvent[] = [];

  const driver = createGoalContinuationDriver({
    debounceMs: overrides?.debounceMs ?? DEBOUNCE_MS,
    jitterMs: overrides?.jitterMs ?? 5_000,
    // Deterministic jitter: pin to 0 so scheduled delays are exact.
    random: () => 0,
    minRearmGapMs: MIN_REARM_GAP_MS,
    maxConsecutiveContinuations: overrides?.maxConsecutiveContinuations ?? 3,
    readGoal: (k) => goals.get(k),
    hasActiveRun: (k) => activeRuns.has(k),
    isInboundQueueEmpty: (k) => !nonEmptyQueues.has(k),
    buildContinuationPrompt: (goal) => formatGoalDriverContinuationPrompt(goal),
    fireContinuation: (sessionKey, prompt) => fires.push({ sessionKey, prompt }),
    recordContinuation: (k) => {
      const goal = goals.get(k);
      if (goal) {
        goal.continuationTurns += 1;
      }
    },
    resetContinuations: (k) => {
      const goal = goals.get(k);
      if (goal) {
        goal.continuationTurns = 0;
      }
    },
    pauseGoal: (k) => {
      const goal = goals.get(k);
      if (goal) {
        goal.status = "paused";
      }
    },
    onEvent: (evt) => events.push(evt),
  });

  const setGoal = (sessionKey: string, patch: Partial<GoalDriverGoalSnapshot> = {}) => {
    goals.set(sessionKey, {
      status: "active",
      objective: "ship the feature",
      tokensUsed: 0,
      continuationTurns: 0,
      ...patch,
    });
  };

  return { driver, goals, activeRuns, nonEmptyQueues, fires, events, setGoal };
}

/** Delays passed to setTimeout since the spy was installed. */
function timeoutDelays(spy: ReturnType<typeof vi.spyOn>): number[] {
  return (spy.mock.calls as Array<[unknown, unknown, ...unknown[]]>)
    .map(([, delay]) => delay)
    .filter((d): d is number => typeof d === "number");
}

let h: Harness;

beforeEach(() => {
  vi.useFakeTimers();
  h = createHarness();
});

afterEach(() => {
  h.driver.stop();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("GoalContinuationDriver — loop safety", () => {
  it("(a) never fires while a run is active or the inbound queue is non-empty", () => {
    h.setGoal("s1");
    h.activeRuns.add("s1");
    h.driver.onTurnCompleted({ sessionKey: "s1", turnWasGoalContinuation: false });

    // Wake past the debounce while a run is active -> must re-arm, not fire.
    vi.advanceTimersByTime(DEBOUNCE_MS + 1);
    expect(h.fires).toHaveLength(0);
    // Keep polling at the floor while still busy: bounded, never a fire.
    vi.advanceTimersByTime(MIN_REARM_GAP_MS * 3 + 1);
    expect(h.fires).toHaveLength(0);
    expect(h.events.some((e) => e.kind === "rearmed" && e.reason === "active-run")).toBe(true);

    // Run clears but the inbound queue is non-empty -> still no fire.
    h.activeRuns.delete("s1");
    h.nonEmptyQueues.add("s1");
    vi.advanceTimersByTime(MIN_REARM_GAP_MS + 1);
    expect(h.fires).toHaveLength(0);
    expect(h.events.some((e) => e.kind === "rearmed" && e.reason === "queue-nonempty")).toBe(true);

    // Both gates clear -> exactly one continuation fires.
    h.nonEmptyQueues.delete("s1");
    vi.advanceTimersByTime(MIN_REARM_GAP_MS + 1);
    expect(h.fires).toHaveLength(1);
    expect(h.fires[0]?.sessionKey).toBe("s1");
    expect(isGoalDriverContinuationPrompt(h.fires[0]?.prompt)).toBe(true);
  });

  it("(b) a fired continuation that ends idle again waits >= debounce (no tight loop)", () => {
    h.setGoal("s1");
    h.driver.onTurnCompleted({ sessionKey: "s1", turnWasGoalContinuation: false });

    const spy = vi.spyOn(globalThis, "setTimeout");
    // First continuation fires after the debounce.
    vi.advanceTimersByTime(DEBOUNCE_MS + 1);
    expect(h.fires).toHaveLength(1);

    // Firing must NOT schedule an immediate follow-up timer (no setTimeout here).
    expect(timeoutDelays(spy)).toHaveLength(0);

    // The fired turn runs and completes idle again (a driver continuation).
    h.driver.onTurnCompleted({ sessionKey: "s1", turnWasGoalContinuation: true });
    // The re-arm after a continuation turn uses the full debounce, never the floor.
    const delays = timeoutDelays(spy);
    expect(delays).toHaveLength(1);
    expect(delays[0]).toBe(DEBOUNCE_MS);
    expect(delays[0]).toBeGreaterThanOrEqual(DEBOUNCE_MS);

    // No second fire until the full debounce elapses again.
    vi.advanceTimersByTime(DEBOUNCE_MS - 1);
    expect(h.fires).toHaveLength(1);
    vi.advanceTimersByTime(2);
    expect(h.fires).toHaveLength(2);
    spy.mockRestore();
  });

  it("(c) auto-pauses after the consecutive-continuation ceiling", () => {
    h.setGoal("s1");
    // Simulate the fire -> continuation-turn-completes cycle repeatedly. The turn
    // input is always a driver continuation, so the ceiling counter never resets.
    const cycle = () => {
      h.driver.onTurnCompleted({ sessionKey: "s1", turnWasGoalContinuation: true });
      vi.advanceTimersByTime(DEBOUNCE_MS + 1);
    };
    // Prime the first arm from a real inbound turn, then run continuation cycles.
    h.driver.onTurnCompleted({ sessionKey: "s1", turnWasGoalContinuation: false });
    vi.advanceTimersByTime(DEBOUNCE_MS + 1); // fire #1 (continuationTurns 0 -> 1)
    cycle(); // fire #2 (1 -> 2)
    cycle(); // fire #3 (2 -> 3)

    expect(h.fires).toHaveLength(3);
    expect(h.goals.get("s1")?.status).toBe("active");

    // The 4th wake sees continuationTurns == ceiling -> auto-pause, no 4th fire.
    cycle();
    expect(h.fires).toHaveLength(3);
    expect(h.goals.get("s1")?.status).toBe("paused");
    expect(h.events.some((e) => e.kind === "paused")).toBe(true);

    // A paused goal stays disarmed: further wakes cannot fire.
    vi.advanceTimersByTime(DEBOUNCE_MS * 2);
    expect(h.fires).toHaveLength(3);
  });

  it("(c') a real inbound turn resets the ceiling counter", () => {
    h.setGoal("s1", { continuationTurns: 2 });
    // A genuine user turn arrives -> counter resets to 0 before re-arming.
    h.driver.onTurnCompleted({ sessionKey: "s1", turnWasGoalContinuation: false });
    expect(h.goals.get("s1")?.continuationTurns).toBe(0);
    vi.advanceTimersByTime(DEBOUNCE_MS + 1);
    // Fires because the reset moved it back below the ceiling.
    expect(h.fires).toHaveLength(1);
    expect(h.goals.get("s1")?.status).toBe("active");
  });

  it("(d) a budget_limited transition mid-wait disarms without firing", () => {
    h.setGoal("s1");
    h.driver.onTurnCompleted({ sessionKey: "s1", turnWasGoalContinuation: false });

    // Budget exhaustion flips the goal terminal-ish while the timer is pending.
    const goal = h.goals.get("s1");
    if (goal) {
      goal.status = "budget_limited";
    }
    vi.advanceTimersByTime(DEBOUNCE_MS + 1);

    expect(h.fires).toHaveLength(0);
    expect(h.driver.pendingCount()).toBe(0);
    expect(h.events.some((e) => e.kind === "disarmed" && e.reason === "goal-inactive")).toBe(true);
  });

  it("(e) restart re-arm from persisted goals is idempotent (no double fire)", () => {
    h.setGoal("s1");
    h.setGoal("s2");
    h.goals.set("s3", {
      status: "paused",
      objective: "later",
      tokensUsed: 0,
      continuationTurns: 0,
    });

    // Simulate two restart-recovery passes racing (e.g. reconcile fired twice).
    h.driver.rearmActiveGoals(["s1", "s2", "s3"]);
    h.driver.rearmActiveGoals(["s1", "s2", "s3"]);

    // Only the two active goals are armed, and each has exactly one pending timer.
    expect(h.driver.pendingCount()).toBe(2);

    vi.advanceTimersByTime(DEBOUNCE_MS + 1);
    // Each active session fires exactly once despite the double re-arm.
    expect(h.fires.filter((f) => f.sessionKey === "s1")).toHaveLength(1);
    expect(h.fires.filter((f) => f.sessionKey === "s2")).toHaveLength(1);
    expect(h.fires.filter((f) => f.sessionKey === "s3")).toHaveLength(0);
  });

  it("stop() cancels every pending timer", () => {
    h.setGoal("s1");
    h.setGoal("s2");
    h.driver.rearmActiveGoals(["s1", "s2"]);
    expect(h.driver.pendingCount()).toBe(2);
    h.driver.stop();
    expect(h.driver.pendingCount()).toBe(0);
    vi.advanceTimersByTime(DEBOUNCE_MS * 2);
    expect(h.fires).toHaveLength(0);
  });
});
