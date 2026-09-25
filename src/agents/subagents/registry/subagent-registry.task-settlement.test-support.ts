import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import {
  createPluginRegistryOwner,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { createRunningTaskRun } from "../../../tasks/detached-task-runtime.js";
import { getTaskFlowByIdForOwner } from "../../../tasks/task-flow-owner-access.js";
import { readTaskRegistryRevision } from "../../../tasks/task-registry-state.js";
import {
  configureTaskRegistryRuntime,
  getTaskRegistryStore,
  onTaskRegistryChange,
} from "../../../tasks/task-registry.store.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "../../../tasks/task-runtime.test-helpers.js";
import { findTaskByRunIdForStatus } from "../../../tasks/task-status-access.js";
import {
  createSessionEntry,
  createSubagentRunRecord,
  mockGatewayMethods,
  waitForFast,
  type SubagentRegistryHarness,
} from "../../subagent-test-fixtures.test-helpers.js";
import { SUBAGENT_ENDED_REASON_COMPLETE } from "./subagent-lifecycle-events.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import type { createSubagentRegistryMockState } from "./subagent-registry.mock-state.test-support.js";
import {
  makeKilledRun,
  makeRunningTaskParams,
} from "./subagent-registry.run-fixtures.test-support.js";

type RestoredTaskSettlementTestOptions = {
  getRegistry: () => SubagentRegistryHarness;
  mocks: Pick<
    ReturnType<typeof createSubagentRegistryMockState>,
    | "entries"
    | "restoreSubagentRunsFromDisk"
    | "callGateway"
    | "runSubagentAnnounceFlow"
    | "dispatchRecoveryAgent"
  >;
  hydrateAndActivateRegistry: () => void;
};

export function registerRestoredTaskSettlementTest({
  getRegistry,
  mocks,
  hydrateAndActivateRegistry,
}: RestoredTaskSettlementTestOptions): void {
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
      await mod.registerSubagentRun({ runId, childSessionKey, task: "predecessor", collect: true });
      await writerEntered.promise;
      await mod.registerSubagentRun({ runId, childSessionKey, task: "replacement", collect: true });
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

export function registerRestoredRunningTaskSettlementTest({
  getRegistry,
  mocks,
  hydrateAndActivateRegistry,
}: RestoredTaskSettlementTestOptions): void {
  it.each(["done"] as const)(
    "settles and announces a retired running row whose saved session completed as %s",
    async (status) => {
      const mod = getRegistry();
      const findRequesterRun = (runId: string) =>
        mod.listSubagentRunsForRequester("agent:main:main").find((entry) => entry.runId === runId);
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      const announceEntered = createDeferred();
      mocks.runSubagentAnnounceFlow.mockImplementationOnce(async () => {
        announceEntered.resolve();
        return "delivered";
      });
      const settleRootWork = observeRootWork();
      try {
        const startedAt = Date.now() - 2_000;
        const endedAt = Date.now() - 1_000;
        const runId = "run-restored-completed-session";
        const childSessionKey = "agent:main:subagent:restored-completed-session";
        mocks.entries = {
          [childSessionKey]: createSessionEntry({
            status,
            startedAt,
            endedAt,
            updatedAt: endedAt,
            lifecycleRevision: "revision-child",
            lifecycleRunId: runId,
            abortedLastRun: false,
          }),
        };
        expect(
          createRunningTaskRun(
            makeRunningTaskParams({ runId, childSessionKey, startedAt, task: "saved completion" }),
          ),
        ).not.toBeNull();
        const restored = createSubagentRunRecord({
          runId,
          childSessionKey,
          task: "saved completion",
          createdAt: startedAt,
          execution: { status: "running", startedAt, lifecycleGeneration: "retired-generation" },
        });
        mocks.restoreSubagentRunsFromDisk.mockImplementation((params) => {
          params.runs.set(runId, restored);
          return 1;
        });
        mockGatewayMethods(mocks.callGateway, { "agent.wait": { status: "timeout" } });

        hydrateAndActivateRegistry();

        await announceEntered.promise;
        await settleRootWork(true);
        expect(findRequesterRun(runId)).toMatchObject({
          execution: { status: "terminal", endedAt, outcome: { status: "ok" } },
          endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
          delivery: { status: "delivered" },
        });
        expect(findTaskByRunIdForStatus(runId)).toMatchObject({ status: "succeeded", endedAt });
        expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            childRunId: runId,
            outcome: expect.objectContaining({ status: "ok" }),
          }),
        );
        expect(mocks.dispatchRecoveryAgent).not.toHaveBeenCalled();
      } finally {
        await settleRootWork();
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });
      }
    },
  );
}

export function registerReplacedGenerationTaskSettlementTest({
  getRegistry,
  mocks,
}: Omit<RestoredTaskSettlementTestOptions, "hydrateAndActivateRegistry">): void {
  it.each([
    { name: "unchanged", replaced: false },
    { name: "replaced by a plugin reload", replaced: true },
  ])(
    "settles a child task when the spawning generation is $name",
    async ({ replaced }) => {
      const mod = getRegistry();
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      const runId = `run-spawn-generation-${String(replaced)}`;
      const spawning = createEmptyPluginRegistry();
      setActivePluginRegistry(spawning);
      const gateway = createPluginRegistryOwner(spawning);
      const childEnded = createDeferred<{ status: "ok"; startedAt: number; endedAt: number }>();
      mockGatewayMethods(mocks.callGateway, { "agent.wait": () => childEnded.promise });
      const settled = createDeferred();
      // The task registry publishes the terminal write; await it instead of polling.
      const stopObserving = onTaskRegistryChange(() => {
        if (findTaskByRunIdForStatus(runId)?.status === "succeeded") {
          settled.resolve();
        }
      });
      const settleRootWork = observeRootWork();
      try {
        // The spawning turn runs inside its admitted plugin generation.
        await withPluginRuntimeRegistryScope(spawning, () =>
          mod.registerSubagentRun({
            runId,
            task: "outlive a plugin reload",
            expectsCompletionMessage: false,
          }),
        );
        expect(findTaskByRunIdForStatus(runId)).toMatchObject({ status: "running" });
        if (replaced) {
          // A plugin enable/disable publishes the Gateway's successor while the child still runs.
          const successor = createEmptyPluginRegistry();
          setActivePluginRegistry(successor);
          gateway.publish(successor);
        }
        childEnded.resolve({ status: "ok", startedAt: Date.now() - 1_000, endedAt: Date.now() });

        await settled.promise;
        expect(findTaskByRunIdForStatus(runId)).toMatchObject({ status: "succeeded" });
      } finally {
        stopObserving();
        await settleRootWork();
        resetPluginRuntimeStateForTest();
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });
      }
      // An unsettled child never publishes; fail promptly instead of waiting on retries.
    },
    10_000,
  );
}

export function registerProvisionalKillCompletionSettlementTest({
  getRegistry,
  mocks,
}: {
  getRegistry: () => SubagentRegistryHarness;
  mocks: Pick<ReturnType<typeof createSubagentRegistryMockState>, "entries">;
}): void {
  it("reconciles persisted completion before expiring a provisional kill", async () => {
    const mod = getRegistry();
    const findRequesterRun = (runId: string) =>
      mod.listSubagentRunsForRequester("agent:main:main").find((entry) => entry.runId === runId);
    const settleRootWork = observeRootWork();
    try {
      const startedAt = Date.parse("2026-03-24T11:50:00Z");
      const killedAt = Date.parse("2026-03-24T11:55:00Z");
      const endedAt = Date.parse("2026-03-24T11:56:00Z");
      mocks.entries = {
        "agent:main:subagent:child": createSessionEntry({
          updatedAt: endedAt,
          status: "done",
          startedAt,
          endedAt,
        }),
      };
      mod.addSubagentRunForTests(
        makeKilledRun(killedAt, {
          runId: "run-killed-with-persisted-completion",
          task: "recover persisted completion",
          createdAt: startedAt,
          startedAt,
        }),
      );

      await mod.testing.sweepOnceForTests();

      await waitForFast(() => {
        const run = findRequesterRun("run-killed-with-persisted-completion");
        expect(run?.endedReason).toBe(SUBAGENT_ENDED_REASON_COMPLETE);
        expect(run?.execution.outcome).toMatchObject({ status: "ok", startedAt, endedAt });
        expect(run?.archiveAtMs).toBeUndefined();
      });
    } finally {
      await settleRootWork();
    }
  });
}
