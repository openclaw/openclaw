// Integration probe (spike S3): drive the GoalContinuationDriver against the
// REAL gate predicates and the REAL system-event enqueue path — not vi.fn mocks.
//
// What this proves:
//  - g2 uses the shipped resolveVisibleActiveSessionRunState against a real
//    chatAbortControllers Map;
//  - g3 uses the shipped listQueuedChatTurnsForSession + hasSystemEvents;
//  - FIRE reaches enqueueSystemEventEntry, landing a continuation on the exact
//    session queue the heartbeat-runner drains to start a turn.
//
// What it CANNOT prove in-process (documented, not asserted): the enqueued
// system event actually reaching a live agent run. That requires the
// heartbeat-runner + a live session loop (a running gateway), which no cron unit
// test harness exercises either — the cron main-session path (executeMainSessionCronJob)
// hands off to runHeartbeatOnce/requestHeartbeat, both gateway-live deps.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isFormattedGoalContinuationPrompt } from "../../auto-reply/reply/commands-goal.js";
import type { ChatAbortControllerEntry } from "../../gateway/chat-abort.js";
import {
  registerQueuedChatTurn,
  completeQueuedChatTurn,
  listQueuedChatTurnsForSession,
  type QueuedChatTurnMap,
} from "../../gateway/chat-queued-turns.js";
import { hasVisibleActiveSessionRun } from "../../gateway/server-methods/session-active-runs.js";
import {
  hasSystemEvents,
  peekSystemEvents,
  enqueueSystemEventEntry,
  resetSystemEventsForTest,
} from "../../infra/system-events.js";
import {
  formatGoalDriverContinuationPrompt,
  isGoalDriverContinuationPrompt,
} from "./continuation-prompt.js";
import { createGoalContinuationDriver, type GoalDriverGoalSnapshot } from "./driver.js";

const DEBOUNCE_MS = 20_000;
const SESSION = "agent:main:probe";

function makeVisibleRunEntry(sessionKey: string): ChatAbortControllerEntry {
  // Only the fields collectTrackedActiveSessionRuns reads matter here.
  return {
    controller: new AbortController(),
    sessionKey,
    sessionId: `${sessionKey}#sid`,
    projectSessionActive: true,
    controlUiVisible: true,
    kind: "chat-send",
  } as unknown as ChatAbortControllerEntry;
}

function createProbe() {
  const goals = new Map<string, GoalDriverGoalSnapshot>([
    [
      SESSION,
      { status: "active", objective: "finish the migration", tokensUsed: 10, continuationTurns: 0 },
    ],
  ]);
  const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
  const chatQueuedTurns: QueuedChatTurnMap = new Map();

  const driver = createGoalContinuationDriver({
    debounceMs: DEBOUNCE_MS,
    jitterMs: 0,
    random: () => 0,
    readGoal: (k) => goals.get(k),
    // g2 — real predicate over the gateway's active-run registry.
    hasActiveRun: (k) =>
      hasVisibleActiveSessionRun({
        context: { chatAbortControllers },
        requestedKey: k,
        canonicalKey: k,
      }),
    // g3 — real queued-turn + system-event predicates.
    isInboundQueueEmpty: (k) =>
      listQueuedChatTurnsForSession({ chatQueuedTurns, sessionKeys: [k] }).length === 0 &&
      !hasSystemEvents(k),
    buildContinuationPrompt: (goal) => formatGoalDriverContinuationPrompt(goal),
    // FIRE — real system-event enqueue (the heartbeat-runner drains this queue).
    fireContinuation: (k, prompt) => {
      enqueueSystemEventEntry(prompt, { sessionKey: k });
    },
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
  });

  return { driver, goals, chatAbortControllers, chatQueuedTurns };
}

let p: ReturnType<typeof createProbe>;

beforeEach(() => {
  vi.useFakeTimers();
  resetSystemEventsForTest();
  p = createProbe();
});

afterEach(() => {
  p.driver.stop();
  resetSystemEventsForTest();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("GoalContinuationDriver — integration probe (real gate + enqueue path)", () => {
  it("fires a continuation onto the real system-event queue the heartbeat-runner drains", () => {
    expect(hasSystemEvents(SESSION)).toBe(false);
    p.driver.onTurnCompleted({ sessionKey: SESSION, turnWasGoalContinuation: false });
    vi.advanceTimersByTime(DEBOUNCE_MS + 1);

    const events = peekSystemEvents(SESSION);
    expect(events).toHaveLength(1);
    expect(isGoalDriverContinuationPrompt(events[0])).toBe(true);
    // The continuation restates the objective as untrusted data (codex parity).
    expect(events[0]).toContain("finish the migration");
    // Budget line carries live accounting from the goal snapshot.
    expect(events[0]).toContain("Tokens used: 10");
  });

  it("g2: a real visible active run blocks the fire, and clearing it unblocks", () => {
    p.chatAbortControllers.set("run-1", makeVisibleRunEntry(SESSION));
    p.driver.onTurnCompleted({ sessionKey: SESSION, turnWasGoalContinuation: false });

    vi.advanceTimersByTime(DEBOUNCE_MS + 1);
    expect(hasSystemEvents(SESSION)).toBe(false); // blocked by the active run

    p.chatAbortControllers.delete("run-1");
    vi.advanceTimersByTime(5_000);
    expect(peekSystemEvents(SESSION)).toHaveLength(1); // fires once the run clears
  });

  it("g3: a real queued chat turn blocks the fire, and completing it unblocks", () => {
    const ok = registerQueuedChatTurn({
      chatQueuedTurns: p.chatQueuedTurns,
      runId: "queued-1",
      controller: new AbortController(),
      sessionId: `${SESSION}#sid`,
      sessionKey: SESSION,
    });
    expect(ok).toBe(true);

    p.driver.onTurnCompleted({ sessionKey: SESSION, turnWasGoalContinuation: false });
    vi.advanceTimersByTime(DEBOUNCE_MS + 1);
    expect(hasSystemEvents(SESSION)).toBe(false); // blocked by the queued inbound turn

    completeQueuedChatTurn(p.chatQueuedTurns, "queued-1");
    vi.advanceTimersByTime(5_000);
    expect(peekSystemEvents(SESSION)).toHaveLength(1);
  });

  it("the shared /goal detector now recognizes driver continuations (folded marker)", () => {
    const prompt = formatGoalDriverContinuationPrompt({
      objective: "x",
      tokensUsed: 0,
    });
    // The driver marker is recognized by the driver's own detector...
    expect(isGoalDriverContinuationPrompt(prompt)).toBe(true);
    // ...and PR-C folded that marker into the shared /goal-command detector, so
    // the gateway classifies driver turns uniformly for the ceiling reset.
    expect(isFormattedGoalContinuationPrompt(prompt)).toBe(true);
  });
});
