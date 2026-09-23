import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createRunningTaskRun } from "../../../tasks/detached-task-runtime.js";
import { getTaskFlowByIdForOwner } from "../../../tasks/task-flow-owner-access.js";
import { readTaskRegistryRevision } from "../../../tasks/task-registry-state.js";
import {
  configureTaskRegistryRuntime,
  getTaskRegistryStore,
} from "../../../tasks/task-registry.store.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "../../../tasks/task-runtime.test-helpers.js";
import { findTaskByRunIdForStatus } from "../../../tasks/task-status-access.js";
import {
  createSessionEntry,
  createSubagentRunRecord,
  type SubagentRegistryHarness,
} from "../../subagent-test-fixtures.test-helpers.js";
import { SUBAGENT_ENDED_REASON_COMPLETE } from "./subagent-lifecycle-events.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import type { createSubagentRegistryMockState } from "./subagent-registry.mock-state.test-support.js";
import { makeRunningTaskParams } from "./subagent-registry.run-fixtures.test-support.js";

export function registerRestoredTaskSettlementTest({
  getRegistry,
  mocks,
  hydrateAndActivateRegistry,
}: {
  getRegistry: () => SubagentRegistryHarness;
  mocks: Pick<
    ReturnType<typeof createSubagentRegistryMockState>,
    "entries" | "restoreSubagentRunsFromDisk" | "callGateway" | "runSubagentAnnounceFlow"
  >;
  hydrateAndActivateRegistry: () => void;
}): void {
  it("does not replay a failed waiter completion onto a same-run replacement", async () => {
    const mod = getRegistry();
    const runId = "waiter-projection-replaced";
    const childSessionKey = "agent:main:subagent:waiter-projection-replaced";
    const writerEntered = createDeferred();
    const rejectWriter = createDeferred();
    const store = getTaskRegistryStore();
    let held = false;
    configureTaskRegistryRuntime({
      store: {
        ...store,
        async runInitialMutationAsync(context, command, assertCurrent, onGranted) {
          if (!held && command.type === "tasks.transitionRunRow") {
            held = true;
            writerEntered.resolve();
            await rejectWriter.promise;
            throw new Error("predecessor task writer refused");
          }
          return store.runInitialMutationAsync(context, command, assertCurrent, onGranted);
        },
      },
    });
    mocks.entries = {
      [childSessionKey]: createSessionEntry({ lifecycleRevision: "waiter-replacement" }),
    };
    mocks.callGateway
      .mockResolvedValueOnce({ status: "timeout", startedAt: 111, endedAt: 222 })
      .mockResolvedValue({ status: "pending" });
    const settleRootWork = observeRootWork();
    try {
      mod.registerSubagentRun({ runId, childSessionKey, task: "predecessor", collect: true });
      await writerEntered.promise;
      mod.registerSubagentRun({ runId, childSessionKey, task: "replacement", collect: true });
      rejectWriter.resolve();
      await expect(settleRootWork()).rejects.toThrow("Failed to settle subagent cleanup roots");
      expect(mod.getSubagentRunByRunId(runId)).toMatchObject({
        task: "replacement",
        execution: { status: "running" },
      });
      expect(mod.getSubagentRunByRunId(runId)?.execution.endedAt).toBeUndefined();
      expect(mod.getSubagentRunByRunId(runId)?.collectorCompletion).toBeUndefined();
      expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
    } finally {
      rejectWriter.resolve();
      configureTaskRegistryRuntime({ store });
    }
  });

  it("repairs a terminal task projection on restore and preserves it on repeated restore", async () => {
    const mod = getRegistry();
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    try {
      const startedAt = Date.now() - 2_000;
      const endedAt = Date.now() - 1_000;
      const runId = "run-restored-task-projection";
      const childSessionKey = "agent:main:subagent:restored-task-projection";
      mocks.entries = {
        [childSessionKey]: createSessionEntry({ lifecycleRevision: "revision-child" }),
      };
      expect(
        createRunningTaskRun(
          makeRunningTaskParams({
            runId,
            childSessionKey,
            task: "restore terminal task projection",
            startedAt,
          }),
        ),
      ).not.toBeNull();
      mocks.restoreSubagentRunsFromDisk.mockImplementation((params) => {
        params.runs.set(
          runId,
          createSubagentRunRecord({
            runId,
            childSessionKey,
            task: "restore terminal task projection",
            cleanup: "keep",
            createdAt: startedAt,
            startedAt,
            endedAt,
            endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
            outcome: { status: "ok" },
            completion: { required: false, resultText: "restored result" },
            cleanupCompletedAt: endedAt,
            suppressCompletionDelivery: true,
          }),
        );
        return 1;
      });

      const settleRootWork = observeRootWork();
      hydrateAndActivateRegistry();

      await settleRootWork(true);
      expect(findTaskByRunIdForStatus(runId)).toMatchObject({
        status: "succeeded",
        endedAt,
        progressSummary: "restored result",
      });
      const restored = expectDefined(findTaskByRunIdForStatus(runId), "restored task");
      const flowId = expectDefined(restored.parentFlowId, "mirrored flow ID");
      const firstFlow = expectDefined(
        getTaskFlowByIdForOwner({ flowId, callerOwnerKey: restored.ownerKey }),
        "restored mirrored flow",
      );
      expect(firstFlow.status).toBe("succeeded");
      const store = getTaskRegistryStore();
      const upsertTask = vi.fn(store.upsertTaskWithDeliveryState);
      configureTaskRegistryRuntime({
        store: { ...store, upsertTaskWithDeliveryState: upsertTask },
      });
      const taskRevision = readTaskRegistryRevision();

      mod.resetSubagentRegistryForTests({ persist: false });
      hydrateAndActivateRegistry();

      await settleRootWork();
      expect(mocks.restoreSubagentRunsFromDisk).toHaveBeenCalledTimes(2);
      expect(findTaskByRunIdForStatus(runId)).toEqual(restored);
      expect(getTaskFlowByIdForOwner({ flowId, callerOwnerKey: restored.ownerKey })).toEqual(
        firstFlow,
      );
      expect(upsertTask).not.toHaveBeenCalled();
      expect(readTaskRegistryRevision()).toBe(taskRevision);
    } finally {
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
    }
  });
}
