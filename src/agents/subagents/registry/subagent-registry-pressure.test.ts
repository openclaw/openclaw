import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { resetGatewayWorkAdmission } from "../../../process/gateway-work-admission.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  registerOpenClawStateDatabaseAsyncResource,
} from "../../../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { observeMainThreadSql } from "../../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { createSubagentSweeperHarness as createHarness } from "./subagent-registry-sweeper.test-support.js";

function createSuspendedBacklog(count: number) {
  const entries = Array.from({ length: count }, (_, index) =>
    createSubagentRunRecord({
      runId: `suspended-${index}`,
      childSessionKey: `agent:main:subagent:suspended-${index}`,
      endedAt: Date.now() - 60_000,
      outcome: { status: "ok" },
      retainAttachmentsOnKeep: true,
      delivery: { status: "suspended", suspendedAt: Date.now(), suspendedReason: "expiry" },
    }),
  );
  const harness = createHarness({}, entries[0]);
  for (const entry of entries) {
    harness.runs.set(entry.runId, entry);
  }
  return { ...harness, entries };
}

describe("subagent suspended delivery pressure", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetGatewayWorkAdmission();
  });
  afterEach(() => {
    resetGatewayWorkAdmission();
    vi.useRealTimers();
  });

  it("keeps pressure and empty sweeps memory-only while state read admission closes", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      openOpenClawStateDatabase();
      const context = captureOpenClawStateWorkerContext();
      const entered = createDeferred();
      const release = createDeferred();
      const unregister = registerOpenClawStateDatabaseAsyncResource({
        close: () => {
          entered.resolve();
          return release.promise;
        },
      });
      const { runs, sweeper, warn, completeCleanupBookkeeping } = createSuspendedBacklog(25);
      const closing = closeOpenClawStateDatabaseByPathAsync(context.admission.databasePath);
      try {
        await entered.promise;
        expect(() => captureOpenClawStateWorkerContext()).toThrow("read admission is closed");
        const sql = observeMainThreadSql();
        try {
          await sweeper.sweepOnce();
          expect(runs.size).toBe(25);
          expect(warn).toHaveBeenCalledExactlyOnceWith(
            "subagent suspended delivery backlog reached warning threshold",
            { suspendedCount: 25, warningThreshold: 25 },
          );
          runs.clear();
          await sweeper.sweepOnce();
          expect(runs.size).toBe(0);
          expect(warn).toHaveBeenCalledOnce();
          expect(completeCleanupBookkeeping).not.toHaveBeenCalled();
          sql.expectIdle();
        } finally {
          sql.restore();
        }
      } finally {
        release.resolve();
        await closing;
        unregister();
        await sweeper.reset();
      }
    });
  });

  it("warns on suspended pressure changes, recovery, and reset without repeating unchanged counts", async () => {
    const { entries, runs, completeCleanupBookkeeping, sweeper, warn } = createSuspendedBacklog(50);
    for (const count of [25, 26, 50, 49, 24, 25]) {
      for (const [index, entry] of entries.entries()) {
        entry.delivery =
          index < count
            ? { status: "suspended", suspendedAt: Date.now(), suspendedReason: "expiry" }
            : { status: "delivered" };
      }
      await sweeper.sweepOnce();
      await sweeper.sweepOnce();
    }
    await sweeper.reset();
    await sweeper.sweepOnce();
    await sweeper.sweepOnce();
    expect(warn.mock.calls).toEqual(
      [25, 26, 50, 49, 25, 25].map((suspendedCount) => [
        "subagent suspended delivery backlog reached warning threshold",
        { suspendedCount, warningThreshold: 25 },
      ]),
    );
    expect(runs.size).toBe(50);
    expect(completeCleanupBookkeeping).not.toHaveBeenCalled();
  });

  it("counts suspended backlog pressure after same-pass seven-day expiry", async () => {
    const { entry, runs, discardTerminalDelivery, completeCleanupBookkeeping, sweeper, warn } =
      createSuspendedBacklog(25);
    entry.delivery = {
      status: "suspended",
      suspendedAt: Date.now() - 7 * 24 * 60 * 60_000,
      suspendedReason: "expiry",
      lastError: "requester unavailable",
    };
    discardTerminalDelivery.mockImplementation((discarded) => {
      discarded.delivery = { status: "discarded" };
    });

    await sweeper.sweepOnce();

    expect(discardTerminalDelivery).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ runId: entry.runId, childSessionKey: entry.childSessionKey }),
      Date.now(),
      "expired",
    );
    expect(entry.delivery?.status).toBe("suspended");
    expect(runs.get(entry.runId)?.delivery?.status).toBe("discarded");
    expect(completeCleanupBookkeeping).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "subagent suspended delivery discarded",
      expect.objectContaining({
        runId: entry.runId,
        reason: "expired",
        suspendedAt: entry.delivery?.suspendedAt,
        suspendedReason: "expiry",
        lastError: "requester unavailable",
        recovery:
          "Inspect retained results with /subagents info <runId>; session history depends on cleanup and retention.",
      }),
    );
    expect(runs.size).toBe(25);
  });

  it("still reports and deduplicates suspended backlog pressure when a sweep fails", async () => {
    const { entry, resumeRequesterSettleWake, sweeper, warn } = createSuspendedBacklog(25);
    entry.requesterSettleWake = { status: "pending", attemptCount: 0 };
    resumeRequesterSettleWake.mockImplementation(() => {
      throw new Error("requester wake failed");
    });

    await sweeper.runTick();
    await sweeper.runTick();

    expect(warn.mock.calls).toEqual([
      [
        "subagent suspended delivery backlog reached warning threshold",
        { suspendedCount: 25, warningThreshold: 25 },
      ],
      ["subagent run sweep failed: requester wake failed"],
      ["subagent run sweep failed: requester wake failed"],
    ]);
    resumeRequesterSettleWake.mockReset();
    await sweeper.sweepOnce();
    expect(warn).toHaveBeenCalledTimes(3);
  });
});
