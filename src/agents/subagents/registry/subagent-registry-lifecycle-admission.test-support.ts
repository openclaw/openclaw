import { expect, it, vi } from "vitest";
import { getActiveGatewayRootWorkCount } from "../../../process/gateway-work-admission.js";
import {
  AgentDatabaseAdmissionError,
  createAgentDatabaseInspectionRefusal,
} from "../../../state/agent-database-admission.js";
import {
  createRunEntry,
  readLifecycleRun,
  type LifecycleControllerFixtureOptions,
} from "./subagent-registry-lifecycle-controller.test-support.js";
import type {
  SubagentLifecycleController,
  SubagentLifecycleOptions,
} from "./subagent-registry-lifecycle.js";
import type { RequesterSettleWakeState } from "./subagent-registry.types.js";

type RequesterSettleWakeParams = Parameters<
  SubagentLifecycleOptions["maybeWakeRequesterAfterAllChildrenSettled"]
>[0];

export function registerRequesterDatabaseAdmissionTests({
  createLifecycleController,
  waitForLifecycleState,
}: {
  createLifecycleController: (
    options: LifecycleControllerFixtureOptions,
  ) => SubagentLifecycleController;
  waitForLifecycleState: (assertion: () => void) => Promise<void>;
}) {
  it.each(["ready", "cancelled"])(
    "retains a requester wake through pending database inspection until %s",
    async (outcome) => {
      const wake: RequesterSettleWakeState = {
        status: "dispatching",
        attemptCount: 1,
        replayCount: 1,
        deferralCount: 0,
        batchRunIds: ["run-1"],
        requesterYieldBatch: true,
        rearmGeneration: 1,
      };
      const entry = createRunEntry({ endedAt: 4_000, requesterSettleWake: wake });
      const pending = new AgentDatabaseAdmissionError(
        createAgentDatabaseInspectionRefusal({
          agentId: "main",
          paths: ["/synthetic/main.sqlite"],
          pending: true,
          reason: "Startup inspection is still running",
        }),
      );
      let ready = false;
      const settleWake = vi.fn(async (params: RequesterSettleWakeParams) => {
        if (!ready) {
          throw pending;
        }
        await params.completeBatch([params.settledEntry], wake.rearmGeneration, {
          delivered: true,
          path: "direct",
        });
        return true;
      });
      const controller = createLifecycleController({
        entry,
        maybeWakeRequesterAfterAllChildrenSettled: settleWake,
      });
      vi.useFakeTimers();
      try {
        controller.resumeRequesterSettleWake(entry.runId, entry);
        await vi.advanceTimersByTimeAsync(0);
        expect(readLifecycleRun(entry).requesterSettleWake).toEqual({
          ...wake,
          nextAttemptAt: Date.now() + 30_000,
        });
        expect(getActiveGatewayRootWorkCount()).toBe(0);
        // Startup can outlast both delivery and stale-deferral budgets. No turn
        // has been admitted, so those budgets and the replay key must be untouched.
        for (let attempt = 0; attempt < 12; attempt++) {
          await vi.advanceTimersByTimeAsync(30_000);
          expect(readLifecycleRun(entry).requesterSettleWake).toEqual({
            ...wake,
            nextAttemptAt: Date.now() + 30_000,
          });
        }
        expect(settleWake).toHaveBeenCalledTimes(13);
        if (outcome === "cancelled") {
          await controller.cancelRequesterSettleWake(readLifecycleRun(entry), () => {});
        } else {
          ready = true;
        }
        await vi.advanceTimersByTimeAsync(30_000);
        expect(settleWake).toHaveBeenCalledTimes(outcome === "cancelled" ? 13 : 14);
        expect(readLifecycleRun(entry).requesterSettleWake).toBeUndefined();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        controller.clearScheduledResumeTimers();
        vi.useRealTimers();
      }
    },
  );

  it.each(["ordinary", "inspection-failed"])(
    "settles bookkeeping after a %s wake rejection before attempt admission",
    async (kind) => {
      const entry = createRunEntry({ endedAt: 4_000 });
      const warn = vi.fn();
      const settleWake = vi.fn(async () => {
        throw kind === "inspection-failed"
          ? new AgentDatabaseAdmissionError(
              createAgentDatabaseInspectionRefusal({
                agentId: "main",
                paths: ["/synthetic/main.sqlite"],
                reason: "Integrity check failed",
              }),
            )
          : new Error("wake exploded");
      });
      const controller = createLifecycleController({
        entry,
        warn,
        maybeWakeRequesterAfterAllChildrenSettled: settleWake,
      });

      await expect(
        controller.completeCleanupBookkeeping({
          runId: entry.runId,
          entry,
          cleanup: "keep",
          completedAt: 5_000,
        }),
      ).resolves.toBeUndefined();

      await waitForLifecycleState(() => {
        expect(warn).toHaveBeenCalledWith("requester settle wake failed", expect.anything());
        expect(readLifecycleRun(entry).requesterSettleWake).toBeUndefined();
      });
    },
  );
}
