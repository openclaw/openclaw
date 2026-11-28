import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import * as completionStore from "../completion/subagent-completion-admission.store.js";
import {
  createArchivedSubagentSweeperRun,
  createSubagentSweeperHarness,
  createSubagentSweeperRun,
} from "./subagent-registry-sweeper.test-support.js";

beforeEach(() => {
  resetGatewayWorkAdmission();
  vi.useFakeTimers();
});
afterEach(() => {
  resetGatewayWorkAdmission();
  vi.useRealTimers();
});

it("settles a legacy failed result into requester history before session-run retention", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const settledAt = Date.now() - 6 * 60_000;
    const entry = createArchivedSubagentSweeperRun({
      spawnMode: "session",
      cleanup: "keep",
      archiveAtMs: undefined,
      cleanupCompletedAt: settledAt,
      expectsCompletionMessage: true,
      // Older builds left an undelivered result like this after their retry gave up.
      delivery: { status: "failed", lastError: "completion agent failed" },
    });
    const { sweeper, runs, callGateway } = createSubagentSweeperHarness(entry);
    const settle = vi
      .spyOn(completionStore, "settleSubagentCompletionInHistory")
      .mockResolvedValue(false);
    try {
      await sweeper.sweepOnce();
      expect(settle.mock.calls.map(([{ subagent }]) => subagent.runId)).toEqual([entry.runId]);
      expect(runs.has(entry.runId)).toBe(true);
      expect(callGateway).not.toHaveBeenCalled();
    } finally {
      settle.mockRestore();
    }
  });
});

it("retains retirement candidates until their requester turn consumes the result", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const entry = createArchivedSubagentSweeperRun({
      retireAfterSettle: true,
      requesterTurnRunId: "awaiting-result",
      expectsCompletionMessage: true,
      delivery: { status: "delivered" },
    });
    const { sweeper, runs, callGateway } = createSubagentSweeperHarness(entry);
    await sweeper.sweepOnce();
    expect(runs.has(entry.runId)).toBe(true);
    expect(callGateway).not.toHaveBeenCalled();

    runs.set(entry.runId, { ...entry, requesterTurnRunId: undefined });
    await sweeper.sweepOnce();
    expect(runs.has(entry.runId)).toBe(false);
    expect(callGateway).toHaveBeenCalledOnce();
  });
});

it("lets I/O run during a retained backlog and skips owners replaced between batches", async () => {
  vi.useRealTimers();
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const entry = createArchivedSubagentSweeperRun({
      cleanup: "keep",
      archiveAtMs: Number.MAX_SAFE_INTEGER,
      cleanupCompletedAt: 1,
      delivery: { status: "suspended", suspendedAt: Date.now(), suspendedReason: "expiry" },
      requesterTurnRunId: "retained-requester",
      expectsCompletionMessage: true,
    });
    const { sweeper, runs, warn } = createSubagentSweeperHarness(entry);
    runs.clear();
    for (let index = 0; index < 1024; index++) {
      runs.set(`run-${index}`, { ...entry, runId: `run-${index}` });
    }
    let visitedBeforeIo = 0;
    // Expire the processing budget independently of host speed; keep real event-loop turns.
    let clockNow = performance.now();
    const clock = vi.spyOn(performance, "now").mockImplementation(() => (clockNow += 5));
    const settle = vi
      .spyOn(completionStore, "settleSubagentCompletionInHistory")
      .mockResolvedValue(false);
    const sweep = sweeper.runTick();
    const io = new Promise<void>((resolve) => {
      setImmediate(() => {
        visitedBeforeIo = settle.mock.calls.length;
        runs.set("run-1023", { ...entry, runId: "run-1023", generation: 1 });
        resolve();
      });
    });
    try {
      await Promise.all([sweep, io]);
      expect(visitedBeforeIo).toBeGreaterThan(0);
      expect(visitedBeforeIo).toBeLessThan(1024);
      expect(settle.mock.calls.map(([{ subagent }]) => subagent.runId)).toEqual(
        Array.from({ length: 1023 }, (_, index) => `run-${index}`),
      );
      expect(warn).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
      settle.mockRestore();
    }
  });
});

it("cancels last-row sweeps and restores cadence", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { sweeper, runs, sweepPendingLifecycle, warn } = createSubagentSweeperHarness();
    sweeper.start();
    runs.clear();
    sweeper.stopIfIdle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sweepPendingLifecycle).not.toHaveBeenCalled();

    const successor = createSubagentSweeperRun();
    runs.set(successor.runId, successor);
    sweeper.start();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(sweepPendingLifecycle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sweepPendingLifecycle).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sweepPendingLifecycle).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
    await sweeper.reset();
  });
});

it.each([
  { successor: true, rejection: false },
  { successor: false, rejection: true },
])(
  "joins retirement (successor=$successor, rejection=$rejection)",
  async ({ successor, rejection }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const archived = createArchivedSubagentSweeperRun();
      const { sweeper, runs, callGateway, sweepPendingLifecycle, warn } =
        createSubagentSweeperHarness(archived);
      const cleanup = createDeferred();
      const cleanupFailure = new Error("synthetic cleanup failure");
      callGateway.mockImplementationOnce(() => cleanup.promise);
      sweeper.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(callGateway).toHaveBeenCalledOnce();
      expect(getActiveGatewayRootWorkCount()).toBe(1);

      let retired = false;
      const retirement = sweeper.reset().then(() => {
        retired = true;
      });
      try {
        await Promise.resolve();
        expect(retired).toBe(false);
        if (successor) {
          const next = { ...createSubagentSweeperRun(), runId: "successor" };
          runs.set(next.runId, next);
          sweeper.start();
        }
      } finally {
        if (rejection) {
          cleanup.reject(cleanupFailure);
        } else {
          cleanup.resolve();
        }
        await retirement;
      }
      expect(retired).toBe(true);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      if (rejection) {
        expect(warn).toHaveBeenCalledExactlyOnceWith(
          "sessions.delete failed during subagent sweep; keeping run for retry",
          {
            runId: archived.runId,
            childSessionKey: archived.childSessionKey,
            error: cleanupFailure,
          },
        );
      } else {
        expect(warn).not.toHaveBeenCalled();
      }
      const completedSweeps = sweepPendingLifecycle.mock.calls.length;
      await vi.advanceTimersByTimeAsync(59_999);
      expect(sweepPendingLifecycle).toHaveBeenCalledTimes(completedSweeps);
      await vi.advanceTimersByTimeAsync(1);
      expect(sweepPendingLifecycle).toHaveBeenCalledTimes(completedSweeps + (successor ? 1 : 0));
      await sweeper.reset();
    });
  },
);
