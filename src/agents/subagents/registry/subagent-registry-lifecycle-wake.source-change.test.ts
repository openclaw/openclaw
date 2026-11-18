import { expect, it, vi } from "vitest";
import {
  armRequesterWake,
  currentCompletionRun,
  records,
  requesterWakeDriver,
  seedSubagentCompletionOwner,
  withSubagentCompletionWorkerState,
} from "../completion/subagent-completion-admission.test-helpers.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { createSubagentManagerTestOptions } from "./subagent-registry-queued-recovery.test-support.js";
import { SubagentRecoveryManager } from "./subagent-registry-run-recovery.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";

// mock-isolation: The driver owns lifecycle scheduling; the global registry would install another owner.
vi.mock("./subagent-registry.js", () => ({ resumeSubagentRun: vi.fn() }));

it.each([true, false])(
  "settles a yielded pause notice after its sibling resumes (delivered=%s)",
  async (delivered) => {
    await withSubagentCompletionWorkerState(async (database) => {
      const paused = armRequesterWake(records());
      const sibling = records();
      sibling.subagent.runId = "yielded-sibling";
      sibling.subagent.childSessionKey = "agent:main:subagent:yielded-sibling";
      const batchRunIds = [paused.subagent.runId, sibling.subagent.runId];
      for (const input of [paused, sibling]) {
        armRequesterWake(input, batchRunIds);
        Object.assign(input.subagent, {
          generation: 1,
          pauseReason: "sessions_yield",
          cleanupHandled: false,
          cleanupCompletedAt: undefined,
          completion: { required: true },
          delivery: { status: "pending", disposition: "intentional_non_delivery" },
        });
        input.subagent.execution.outcome = undefined;
        Object.assign(input.subagent.requesterSettleWake!, {
          requesterYieldBatch: true,
          afterRequesterYield: true,
          yieldedFinalDeliverable: true,
          pauseNotice: { acknowledgment: "Waiting for the next instruction." },
        });
        seedSubagentCompletionOwner({ subagent: input.subagent, databaseOptions: { database } });
      }
      paused.subagent.requesterSettleWake!.status = "dispatching";
      paused.subagent.requesterSettleWake!.attemptCount = 1;
      seedSubagentCompletionOwner({ subagent: paused.subagent, databaseOptions: { database } });
      using driver = requesterWakeDriver([paused, sibling]);
      const manager = new SubagentRecoveryManager(
        createSubagentManagerTestOptions(subagentRuns, vi.fn()),
      );
      // Execution I/O is held; replacement and cohort publication remain real.
      vi.spyOn(manager, "waitForSubagentCompletion").mockResolvedValue(undefined);
      const transport = vi.fn();
      driver.wake.mockImplementation(async (params) => {
        if (params.settledEntry.runId === "later-batch") {
          transport();
          await params.completeBatch([params.settledEntry], 1, { delivered: true, path: "direct" });
          return true;
        }
        if (!params.settledEntry.requesterSettleWake?.pauseNotice) {
          params.onDescendantsPending?.();
          return false;
        }
        transport();
        expect(
          await manager.replaceSubagentRunAfterSteer({
            previousRunId: sibling.subagent.runId,
            nextRunId: "resumed-sibling",
            preserveRequesterSettleWake: true,
          }),
        ).toBe(true);
        expect(currentCompletionRun(paused).requesterSettleWake?.batchRunIds).toEqual([
          paused.subagent.runId,
          "resumed-sibling",
        ]);
        expect(params.settledEntry.requesterSettleWake?.batchRunIds).toEqual(batchRunIds);
        await params.completeBatch([params.settledEntry], 1, {
          delivered,
          path: "direct",
          ...(delivered ? {} : { error: "requester refused the notice" }),
        });
        return delivered;
      });
      await driver.run();
      await driver.sweep();
      await driver.sweep();
      expect(transport).toHaveBeenCalledOnce();
      expect(driver.warn).not.toHaveBeenCalled();
      const stored = loadSubagentRegistryFromSqlite().get(paused.subagent.runId)!;
      expect(stored.requesterSettleWake?.pauseNotice).toBeUndefined();
      expect(stored.requesterSettleWake).toMatchObject({
        status: "pending",
        attemptCount: 0,
        batchRunIds: [paused.subagent.runId, "resumed-sibling"],
        requesterYieldBatch: true,
        rearmGeneration: 1,
      });
      expect(stored.delivery).toEqual(paused.subagent.delivery);
      expect(stored.execution.outcome).toBeUndefined();
      const later = armRequesterWake(records());
      later.subagent.runId = "later-batch";
      later.subagent.childSessionKey = "agent:main:subagent:later-batch";
      later.subagent.requesterSettleWake!.batchRunIds = [later.subagent.runId];
      seedSubagentCompletionOwner({ subagent: later.subagent, databaseOptions: { database } });
      await driver.run(later.subagent);
      await driver.sweep();
      expect(transport).toHaveBeenCalledTimes(2);
      expect(driver.warn).not.toHaveBeenCalled();
      const laterStored = loadSubagentRegistryFromSqlite().get(later.subagent.runId)!;
      expect(laterStored.requesterSettleWake).toBeUndefined();
      expect(laterStored.delivery?.status).toBe("delivered");
    });
  },
);
