// Wait-barrier (g5) gate tests for the GoalContinuationDriver. Mirrors the
// discipline of driver.loop-safety.test.ts: fake timers prove a parked goal
// never fires, never consumes a no-progress turn, and auto-resumes once the
// barrier clears (deadline passed / watched session's run ended).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatGoalDriverContinuationPrompt } from "./continuation-prompt.js";
import {
  createGoalContinuationDriver,
  type GoalDriverEvent,
  type GoalDriverGoalSnapshot,
} from "./driver.js";

const DEBOUNCE_MS = 20_000;
const MIN_REARM_GAP_MS = 2_000;

type Harness = ReturnType<typeof createHarness>;

function createHarness() {
  const goals = new Map<string, GoalDriverGoalSnapshot>();
  const activeWaitedSessions = new Set<string>();
  const fires: Array<{ sessionKey: string; prompt: string }> = [];
  const cleared: string[] = [];
  const events: GoalDriverEvent[] = [];
  // A driver-controlled clock so the time barrier is deterministic. Advancing
  // fake timers does not move Date.now(), so the driver reads this instead.
  let clock = 1_000_000;

  const driver = createGoalContinuationDriver({
    debounceMs: DEBOUNCE_MS,
    jitterMs: 0,
    random: () => 0,
    minRearmGapMs: MIN_REARM_GAP_MS,
    maxConsecutiveContinuations: 3,
    now: () => clock,
    readGoal: (k) => goals.get(k),
    hasActiveRun: () => false,
    isInboundQueueEmpty: () => true,
    isWaitedSessionActive: (k) => activeWaitedSessions.has(k),
    clearWaitBarrier: (k) => {
      cleared.push(k);
      const goal = goals.get(k);
      if (goal) {
        delete goal.waitingUntil;
        delete goal.waitingOnSessionKey;
      }
    },
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

  return {
    driver,
    goals,
    activeWaitedSessions,
    fires,
    cleared,
    events,
    setGoal,
    advanceClock: (ms: number) => {
      clock += ms;
    },
  };
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

describe("GoalContinuationDriver — wait barrier (g5)", () => {
  it("(g5-a) a time barrier that has not elapsed re-arms without firing", () => {
    h.setGoal("s1", { waitingUntil: 1_000_000 + 60_000 });
    h.driver.onTurnCompleted({ sessionKey: "s1", turnWasGoalContinuation: false });

    vi.advanceTimersByTime(DEBOUNCE_MS + 1);
    expect(h.fires).toHaveLength(0);
    expect(h.events.some((e) => e.kind === "rearmed" && e.reason === "wait-barrier")).toBe(true);
    // Bounded polling while parked; still never a fire.
    vi.advanceTimersByTime(MIN_REARM_GAP_MS * 3 + 1);
    expect(h.fires).toHaveLength(0);
    expect(h.cleared).toHaveLength(0);
  });

  it("(g5-b) a time barrier clears once the deadline passes, then fires", () => {
    h.setGoal("s1", { waitingUntil: 1_000_000 + 5_000 });
    h.driver.onTurnCompleted({ sessionKey: "s1", turnWasGoalContinuation: false });

    vi.advanceTimersByTime(DEBOUNCE_MS + 1); // parked (deadline not reached)
    expect(h.fires).toHaveLength(0);

    // Move the wall clock past the deadline; the next wake clears + fires.
    h.advanceClock(10_000);
    vi.advanceTimersByTime(MIN_REARM_GAP_MS + 1);
    expect(h.cleared).toEqual(["s1"]);
    expect(h.fires).toHaveLength(1);
  });

  it("(g5-c) a session barrier holds while the watched run is active, then clears", () => {
    h.activeWaitedSessions.add("other-session");
    h.setGoal("s1", { waitingOnSessionKey: "other-session" });
    h.driver.onTurnCompleted({ sessionKey: "s1", turnWasGoalContinuation: false });

    vi.advanceTimersByTime(DEBOUNCE_MS + 1);
    expect(h.fires).toHaveLength(0);
    expect(h.events.some((e) => e.kind === "rearmed" && e.reason === "wait-barrier")).toBe(true);

    // The watched session's run ends -> barrier satisfied -> clear + fire.
    h.activeWaitedSessions.delete("other-session");
    vi.advanceTimersByTime(MIN_REARM_GAP_MS + 1);
    expect(h.cleared).toEqual(["s1"]);
    expect(h.fires).toHaveLength(1);
  });

  it("(g5-d) a parked goal never consumes the no-progress ceiling", () => {
    h.setGoal("s1", { waitingUntil: 1_000_000 + 10 * DEBOUNCE_MS, continuationTurns: 0 });
    h.driver.onTurnCompleted({ sessionKey: "s1", turnWasGoalContinuation: false });

    // Poll through many parked wakes; the ceiling counter must not move and the
    // goal must stay active (never auto-paused by g4).
    for (let i = 0; i < 8; i += 1) {
      vi.advanceTimersByTime(DEBOUNCE_MS + 1);
    }
    expect(h.fires).toHaveLength(0);
    expect(h.goals.get("s1")?.continuationTurns).toBe(0);
    expect(h.goals.get("s1")?.status).toBe("active");
    expect(h.events.some((e) => e.kind === "paused")).toBe(false);
  });

  it("(g5-e) no barrier set -> normal gating fires as before", () => {
    h.setGoal("s1");
    h.driver.onTurnCompleted({ sessionKey: "s1", turnWasGoalContinuation: false });
    vi.advanceTimersByTime(DEBOUNCE_MS + 1);
    expect(h.fires).toHaveLength(1);
    expect(h.cleared).toHaveLength(0);
  });
});
