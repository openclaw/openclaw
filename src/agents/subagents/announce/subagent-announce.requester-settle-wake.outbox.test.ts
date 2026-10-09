// Requester settle wake tests cover the registry-less top-level requester.
import { describe, expect, it, vi } from "vitest";
import {
  registryRuntimeMock,
  readDescendantFacts,
  wakeParams,
} from "./subagent-announce.requester-settle-fixture.test-support.js";
import {
  deliverSpy,
  makeSettledChild,
  transitionBatchSpy,
  completeBatchSpy,
  deliveredCallArg,
} from "./subagent-announce.requester-settle-wake.test-support.js";

const { maybeWakeRequesterAfterAllChildrenSettled } =
  await import("./subagent-announce.requester-settle-wake.js");

describe("maybeWakeRequesterAfterAllChildrenSettled", () => {
  describe("restart-persistent outbox", () => {
    it("keeps active overlap pending and stops waiting on a stale settle blocker", async () => {
      const child = makeSettledChild({
        runId: "run-a",
        delivery: { status: "pending" },
        requesterSettleWake: {
          status: "pending",
          attemptCount: 0,
          batchRunIds: ["run-a"],
          requesterYieldBatch: true,
          rearmGeneration: 1,
        },
      });
      registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([child]);
      readDescendantFacts.mockResolvedValue({ unsettled: true, active: 1 });

      vi.useFakeTimers();
      vi.setSystemTime(0);
      try {
        for (let recheck = 0; recheck < 12; recheck += 1) {
          await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: child }));
          await vi.advanceTimersByTimeAsync(30_000);
        }

        expect(child.requesterSettleWake?.deferralCount).toBe(0);

        readDescendantFacts.mockResolvedValue({ unsettled: false, active: 1 });
        await expect(
          maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: child })),
        ).resolves.toBe(true);

        vi.clearAllMocks();
        child.requesterSettleWake = {
          status: "pending",
          attemptCount: 0,
          batchRunIds: ["run-a"],
          rearmGeneration: 1,
          deferralCount: 8,
        };
        readDescendantFacts.mockResolvedValue({ unsettled: true, active: 0 });

        await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: child }));
        await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: child }));
        expect(transitionBatchSpy).toHaveBeenCalledOnce();
        expect(completeBatchSpy).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(30_000);
        // The spent stale-descendant wait delivers the drained batch; it never
        // terminalizes completed results as undelivered.
        await expect(
          maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: child })),
        ).resolves.toBe(true);
        expect(deliverSpy).toHaveBeenCalledOnce();
        expect(String(deliveredCallArg().triggerMessage)).toContain(
          "a descendant result below it was still undelivered when waiting stopped",
        );
        expect(completeBatchSpy).toHaveBeenCalledOnce();
        expect(completeBatchSpy).toHaveBeenCalledWith(["run-a"], 1, {
          delivered: true,
          path: "direct",
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("delivers a yielded batch whose grandchild delivery never settles", async () => {
      // A grandchild ended but its own delivery stays pending (its parent run
      // died on a provider limit): no descendant is active, the wave is drained.
      const yieldWake = () => ({
        status: "pending" as const,
        attemptCount: 0,
        batchRunIds: ["run-a", "run-b"],
        requesterYieldBatch: true as const,
        rearmGeneration: 1,
      });
      const first = makeSettledChild({
        runId: "run-a",
        delivery: { status: "pending" },
        requesterSettleWake: yieldWake(),
      });
      const second = makeSettledChild({
        runId: "run-b",
        delivery: { status: "pending" },
        requesterSettleWake: yieldWake(),
      });
      registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([first, second]);
      readDescendantFacts.mockResolvedValue({ unsettled: true, active: 0 });

      vi.useFakeTimers();
      vi.setSystemTime(0);
      try {
        for (let recheck = 0; recheck < 9; recheck += 1) {
          await expect(
            maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: second })),
          ).resolves.toBe(false);
          await vi.advanceTimersByTimeAsync(30_000);
        }
        expect(first.requesterSettleWake?.deferralCount).toBe(9);
        expect(deliverSpy).not.toHaveBeenCalled();
        expect(completeBatchSpy).not.toHaveBeenCalled();

        await expect(
          maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: second })),
        ).resolves.toBe(true);
        expect(deliverSpy).toHaveBeenCalledOnce();
        // The forced wake never certifies the unsettled descendant tree as settled.
        const message = String(deliveredCallArg().triggerMessage);
        expect(message).toContain("a descendant result below it was still undelivered");
        expect(message).not.toContain("has now settled, including its descendants");
        expect(completeBatchSpy).toHaveBeenCalledOnce();
        expect(completeBatchSpy).toHaveBeenCalledWith(["run-a", "run-b"], 1, {
          delivered: true,
          path: "direct",
        });
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
