// Judge-branching tests for the GoalContinuationDriver. A stubbed judge proves
// the driver sequences done|continue|wait correctly after the gates pass, and
// that the judge is fail-open (undefined / throw -> fire a normal continuation).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatGoalDriverContinuationPrompt } from "./continuation-prompt.js";
import {
  createGoalContinuationDriver,
  type GoalDriverEvent,
  type GoalDriverGoalSnapshot,
  type GoalJudge,
} from "./driver.js";

const DEBOUNCE_MS = 20_000;

type HarnessOverrides = {
  judgeGoal?: GoalJudge;
  hasActiveRun?: () => boolean;
  isInboundQueueEmpty?: () => boolean;
};

function createHarness(overrides: HarnessOverrides = {}) {
  const goals = new Map<string, GoalDriverGoalSnapshot>();
  const fires: Array<{ sessionKey: string; prompt: string }> = [];
  const completed: Array<{ sessionKey: string; reason?: string }> = [];
  const waited: Array<{ sessionKey: string; seconds?: number; reason?: string }> = [];
  const events: GoalDriverEvent[] = [];

  const driver = createGoalContinuationDriver({
    debounceMs: DEBOUNCE_MS,
    jitterMs: 0,
    random: () => 0,
    minRearmGapMs: 2_000,
    maxConsecutiveContinuations: 3,
    readGoal: (k) => goals.get(k),
    hasActiveRun: overrides.hasActiveRun ?? (() => false),
    isInboundQueueEmpty: overrides.isInboundQueueEmpty ?? (() => true),
    buildContinuationPrompt: (goal) => formatGoalDriverContinuationPrompt(goal),
    fireContinuation: (sessionKey, prompt) => fires.push({ sessionKey, prompt }),
    recordContinuation: (k) => {
      const goal = goals.get(k);
      if (goal) {
        goal.continuationTurns += 1;
      }
    },
    resetContinuations: () => {},
    pauseGoal: (k) => {
      const goal = goals.get(k);
      if (goal) {
        goal.status = "paused";
      }
    },
    ...(overrides.judgeGoal ? { judgeGoal: overrides.judgeGoal } : {}),
    markGoalComplete: (sessionKey, reason) => completed.push({ sessionKey, reason }),
    setWaitBarrier: (sessionKey, params) => waited.push({ sessionKey, ...params }),
    onEvent: (evt) => events.push(evt),
  });

  goals.set("s1", {
    status: "active",
    objective: "ship the feature",
    tokensUsed: 0,
    continuationTurns: 0,
  });

  return { driver, goals, fires, completed, waited, events };
}

let h: ReturnType<typeof createHarness>;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  h?.driver.stop();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("GoalContinuationDriver — judge branching", () => {
  it("done: marks the goal complete and does NOT fire", async () => {
    h = createHarness({ judgeGoal: async () => ({ verdict: "done", reason: "verified" }) });
    h.driver.onTurnCompleted({ sessionKey: "s1", turnWasGoalContinuation: false });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1);

    expect(h.fires).toHaveLength(0);
    expect(h.completed).toEqual([{ sessionKey: "s1", reason: "verified" }]);
    expect(h.events.some((e) => e.kind === "judged" && e.verdict === "done")).toBe(true);
    expect(h.events.some((e) => e.kind === "completed")).toBe(true);
  });

  it("wait: parks on a barrier and does NOT fire", async () => {
    h = createHarness({
      judgeGoal: async () => ({ verdict: "wait", seconds: 45, reason: "CI running" }),
    });
    h.driver.onTurnCompleted({ sessionKey: "s1", turnWasGoalContinuation: false });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1);

    expect(h.fires).toHaveLength(0);
    expect(h.waited).toEqual([{ sessionKey: "s1", seconds: 45, reason: "CI running" }]);
    expect(h.events.some((e) => e.kind === "judged" && e.verdict === "wait")).toBe(true);
  });

  it("continue: fires the continuation and records it", async () => {
    h = createHarness({ judgeGoal: async () => ({ verdict: "continue" }) });
    h.driver.onTurnCompleted({ sessionKey: "s1", turnWasGoalContinuation: false });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1);

    expect(h.fires).toHaveLength(1);
    expect(h.completed).toHaveLength(0);
    expect(h.waited).toHaveLength(0);
    expect(h.goals.get("s1")?.continuationTurns).toBe(1);
    expect(h.events.some((e) => e.kind === "judged" && e.verdict === "continue")).toBe(true);
  });

  it("fail-open: an undefined verdict fires a normal continuation", async () => {
    h = createHarness({ judgeGoal: async () => undefined });
    h.driver.onTurnCompleted({ sessionKey: "s1", turnWasGoalContinuation: false });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1);
    expect(h.fires).toHaveLength(1);
  });

  it("fail-open: a thrown judge fires a normal continuation", async () => {
    h = createHarness({
      judgeGoal: async () => {
        throw new Error("judge exploded");
      },
    });
    h.driver.onTurnCompleted({ sessionKey: "s1", turnWasGoalContinuation: false });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1);
    expect(h.fires).toHaveLength(1);
  });

  it("no judge configured: fires synchronously exactly as before", () => {
    h = createHarness();
    h.driver.onTurnCompleted({ sessionKey: "s1", turnWasGoalContinuation: false });
    vi.advanceTimersByTime(DEBOUNCE_MS + 1);
    expect(h.fires).toHaveLength(1);
    // No judged event when no judge is wired.
    expect(h.events.some((e) => e.kind === "judged")).toBe(false);
  });
});

// The judge is async, so the gates that passed just before it ran can flip
// during deliberation (a user message queues, or the goal is paused). The
// driver must re-check the pre-fire gates after the judge, mirroring the
// synchronous path — never fire/mutate blindly on a stale gate read.
describe("GoalContinuationDriver — post-judge gate re-check (mid-judge race)", () => {
  it("continue but queue filled mid-judge: re-arms queue-nonempty, does NOT fire", async () => {
    let queueEmpty = true;
    h = createHarness({
      isInboundQueueEmpty: () => queueEmpty,
      judgeGoal: async () => {
        // A user turn queues while the judge deliberates.
        queueEmpty = false;
        return { verdict: "continue" };
      },
    });
    h.driver.onTurnCompleted({ sessionKey: "s1", turnWasGoalContinuation: false });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1);

    // Without the re-check the old code fired regardless (this proves fail-without).
    expect(h.fires).toHaveLength(0);
    expect(h.goals.get("s1")?.continuationTurns).toBe(0);
    expect(h.events.some((e) => e.kind === "rearmed" && e.reason === "queue-nonempty")).toBe(true);
  });

  it("continue but an active run started mid-judge: re-arms active-run, does NOT fire", async () => {
    let running = false;
    h = createHarness({
      hasActiveRun: () => running,
      judgeGoal: async () => {
        running = true;
        return { verdict: "continue" };
      },
    });
    h.driver.onTurnCompleted({ sessionKey: "s1", turnWasGoalContinuation: false });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1);

    expect(h.fires).toHaveLength(0);
    expect(h.events.some((e) => e.kind === "rearmed" && e.reason === "active-run")).toBe(true);
  });

  it("goal deactivated mid-judge (continue): disarms, does NOT fire", async () => {
    h = createHarness({
      judgeGoal: async (sk) => {
        const goal = h.goals.get(sk);
        if (goal) {
          goal.status = "paused"; // user paused during deliberation
        }
        return { verdict: "continue" };
      },
    });
    h.driver.onTurnCompleted({ sessionKey: "s1", turnWasGoalContinuation: false });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1);

    expect(h.fires).toHaveLength(0);
    expect(h.events.some((e) => e.kind === "disarmed" && e.reason === "goal-inactive")).toBe(true);
  });

  it("goal deactivated mid-judge (done): does NOT mark complete", async () => {
    h = createHarness({
      judgeGoal: async (sk) => {
        const goal = h.goals.get(sk);
        if (goal) {
          goal.status = "blocked"; // user blocked during deliberation
        }
        return { verdict: "done", reason: "looks done" };
      },
    });
    h.driver.onTurnCompleted({ sessionKey: "s1", turnWasGoalContinuation: false });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1);

    // Old code called markGoalComplete regardless (proves fail-without).
    expect(h.completed).toHaveLength(0);
    expect(h.fires).toHaveLength(0);
    expect(h.events.some((e) => e.kind === "completed")).toBe(false);
    expect(h.events.some((e) => e.kind === "disarmed" && e.reason === "goal-inactive")).toBe(true);
  });

  it("goal deactivated mid-judge (wait): does NOT set a barrier", async () => {
    h = createHarness({
      judgeGoal: async (sk) => {
        const goal = h.goals.get(sk);
        if (goal) {
          goal.status = "paused";
        }
        return { verdict: "wait", seconds: 30 };
      },
    });
    h.driver.onTurnCompleted({ sessionKey: "s1", turnWasGoalContinuation: false });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1);

    expect(h.waited).toHaveLength(0);
    expect(h.events.some((e) => e.kind === "disarmed" && e.reason === "goal-inactive")).toBe(true);
  });
});
