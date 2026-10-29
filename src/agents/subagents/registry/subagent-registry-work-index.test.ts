import { afterEach, expect, it, vi } from "vitest";
import { immutableSubagentRun, subagentRuns } from "./subagent-registry-memory.js";
import * as cleanup from "./subagent-registry-sweep-cleanup.js";
import { orderSubagentSweepEntries } from "./subagent-registry-sweep-order.js";
import { createSubagentSweeperHarness } from "./subagent-registry-sweeper.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function terminal(runId: string, overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId,
    childSessionKey: "agent:main:subagent:" + runId,
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: runId,
    createdAt: 1,
    cleanup: "keep",
    execution: { status: "terminal", endedAt: 2 },
    cleanupCompletedAt: 3,
    delivery: { status: "delivered" },
    ...overrides,
  };
}
const publish = (entry: SubagentRunRecord) =>
  subagentRuns.set(entry.runId, immutableSubagentRun(entry));
const selected = (now: number) => orderSubagentSweepEntries(subagentRuns, now).map(([id]) => id);
afterEach(() => {
  vi.restoreAllMocks();
  subagentRuns.clear();
});

it("indexes publication replacement, deletion, clear/restore and strict cleanup deadlines", () => {
  const history = terminal("history");
  const archive = terminal("archive", { archiveAtMs: 100 });
  const session = terminal("session", { spawnMode: "session" });
  const pending = terminal("pending", { delivery: { status: "pending" } });
  [history, archive, session, pending].forEach(publish);
  expect(selected(99)).toEqual(["pending"]);
  expect(selected(100)).toEqual(["pending", "archive"]);
  publish({ ...archive, archiveAtMs: 200 });
  expect(selected(150)).toEqual(["pending"]);
  publish({ ...archive, archiveAtMs: 151 });
  expect(selected(151)).toEqual(["pending", "archive"]);
  subagentRuns.delete("archive");
  publish(terminal("pending"));
  expect(selected(300_003)).toEqual([]);
  expect(selected(300_004)).toEqual(["session"]);
  publish({ ...history, execution: { status: "running" } });
  expect(selected(300_005)).toEqual(["history", "session"]);
  subagentRuns.clear();
  expect(selected(Infinity)).toEqual([]);
  publish(session);
  expect(selected(300_003)).toEqual([]);
  expect(selected(300_004)).toEqual(["session"]);
});

it.each([
  { delivery: { status: "pending" as const } },
  { delivery: { status: "in_progress" as const } },
  { delivery: { status: "suspended" as const } },
  { cleanupCompletedAt: undefined },
  { requesterTurnRunId: "turn", expectsCompletionMessage: true },
  { requesterSettleWake: { status: "pending" as const, attemptCount: 0 } },
  { pauseReason: "sessions_yield" as const },
  { collectorLaunchCleanupPending: true },
  { terminalOwner: "interrupted-recovery" as const },
  { killIntent: { requestedAt: 1, reason: "stop" } },
  { killReconciliation: { killedAt: 1 } },
  {
    execution: {
      status: "terminal" as const,
      endedAt: 2,
      restartRecovery: {
        sessionId: "s",
        sessionMarker: "m",
        idempotencyKey: "i",
        phase: "reserved" as const,
      },
    },
  },
])("retains terminal work despite historical timestamps: %j", (overrides) => {
  publish(terminal("work", overrides));
  expect(selected(0)).toEqual(["work"]);
  publish(terminal("work"));
  expect(selected(0)).toEqual([]);
});

it("does no historical row iteration or read-scope work on repeated idle sweeps", async () => {
  for (let i = 0; i < 5000; i++) {
    publish(terminal("history-" + i));
  }
  const harness = createSubagentSweeperHarness({}, undefined, subagentRuns);
  const readScope = vi.spyOn(cleanup, "createSubagentSweepReadScope");
  const values = vi.spyOn(subagentRuns, "values");
  const iterator = vi.spyOn(subagentRuns, Symbol.iterator);
  await harness.sweeper.sweepOnce();
  await harness.sweeper.sweepOnce();
  expect(readScope).not.toHaveBeenCalled();
  expect(values).not.toHaveBeenCalled();
  expect(iterator).not.toHaveBeenCalled();
  expect(harness.sweepPendingLifecycle).toHaveBeenCalledTimes(2);
  expect(harness.resumeRequesterSettleWake).not.toHaveBeenCalled();
  expect(harness.callGateway).not.toHaveBeenCalled();
});

it("preserves all seven scheduling phases independently of publication order", () => {
  const now = Date.UTC(2026, 9, 28);
  [
    terminal("cleanup", { archiveAtMs: 1 }),
    terminal("kill", { killReconciliation: { killedAt: 1 } }),
    terminal("young", { createdAt: now, execution: { status: "running" } }),
    terminal("stale", { createdAt: now - 3 * 60 * 60 * 1_000, execution: { status: "running" } }),
    terminal("recovery", { terminalOwner: "interrupted-recovery" }),
    terminal("suspended", { delivery: { status: "suspended", suspendedAt: 1 } }),
    terminal("wake", { requesterSettleWake: { status: "pending", attemptCount: 0 } }),
  ].forEach(publish);
  expect(selected(now)).toEqual([
    "wake",
    "suspended",
    "recovery",
    "stale",
    "young",
    "kill",
    "cleanup",
  ]);
});
