import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGatewayWorkAdmission } from "../../../process/gateway-work-admission.js";
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
    sweeper.reset();
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
    };
    discardTerminalDelivery.mockImplementation((discarded) => {
      discarded.delivery = { status: "discarded" };
    });

    await sweeper.sweepOnce();

    expect(discardTerminalDelivery).toHaveBeenCalledExactlyOnceWith(entry, Date.now(), "expired");
    expect(completeCleanupBookkeeping).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "subagent suspended delivery discarded",
      expect.objectContaining({ runId: entry.runId, reason: "expired" }),
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
