import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { AgentEventPayload } from "../../../infra/agent-events.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import {
  createPluginRegistryOwner,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../../../plugins/runtime/gateway-request-scope.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../../process/gateway-work-admission.js";
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
  expectRecordFields,
  mockGatewayMethods,
  mockCallArg as getMockCallArg,
  waitForFast,
  type SubagentRegistryHarness,
} from "../../subagent-test-fixtures.test-helpers.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
} from "./subagent-lifecycle-events.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import type { createSubagentRegistryMockState } from "./subagent-registry.mock-state.test-support.js";
import {
  makeKilledRun,
  makeRunningTaskParams,
} from "./subagent-registry.run-fixtures.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function registerCompletedTaskSettlementTest({
  getRegistry,
  mocks,
}: {
  getRegistry: () => SubagentRegistryHarness;
  mocks: Pick<
    ReturnType<typeof createSubagentRegistryMockState>,
    | "entries"
    | "runSubagentAnnounceFlow"
    | "emitSessionLifecycleEvent"
    | "persistSubagentRunsToDisk"
    | "persistSubagentRunsToDiskOrThrow"
  >;
}): void {
  it("completes a registered run across timing persistence, lifecycle status, and announce cleanup", async () => {
    const mod = getRegistry();
    mocks.entries["agent:main:subagent:child"] = createSessionEntry({
      lifecycleRevision: "revision-child",
      lastRunError: "previous failure",
      abortedLastRun: true,
    });
    const announceEntered = createDeferred();
    mocks.runSubagentAnnounceFlow.mockImplementationOnce(async () => {
      announceEntered.resolve();
      return "delivered";
    });
    const settleRootWork = observeRootWork();
    try {
      await mod.registerSubagentRun({
        runId: "run-1",
        requesterOrigin: { channel: " quietchat ", accountId: " acct-1 " },
        task: "finish the task",
        cleanup: "delete",
      });
      await announceEntered.promise;
    } finally {
      await settleRootWork();
    }

    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);

    expect(mocks.emitSessionLifecycleEvent).toHaveBeenCalledWith({
      sessionKey: "agent:main:subagent:child",
      reason: "subagent-status",
      parentSessionKey: "agent:main:main",
      label: undefined,
    });

    expectRecordFields(
      getMockCallArg(mocks.runSubagentAnnounceFlow, 0, 0, "completion announce"),
      {
        childSessionKey: "agent:main:subagent:child",
        childRunId: "run-1",
        requesterSessionKey: "agent:main:main",
        requesterOrigin: { channel: "quietchat", accountId: "acct-1" },
        task: "finish the task",
        cleanup: "delete",
        roundOneReply: "final completion reply",
        outcome: {
          status: "ok",
          startedAt: 111,
          endedAt: 222,
          elapsedMs: 111,
        },
      },
      "completion announce params",
    );

    expectRecordFields(
      mocks.entries["agent:main:subagent:child"],
      {
        sessionId: "sess-child",
        startedAt: Date.parse("2026-03-24T12:00:00Z"),
        endedAt: 222,
        runtimeMs: 111,
        status: "done",
      },
      "persisted child session entry",
    );
    expect(mocks.entries["agent:main:subagent:child"]).not.toHaveProperty("lastRunError");
    expect(mocks.entries["agent:main:subagent:child"]).not.toHaveProperty("abortedLastRun");

    expect(mocks.persistSubagentRunsToDisk).toHaveBeenCalled();
    expect(mocks.persistSubagentRunsToDiskOrThrow).toHaveBeenCalled();
  });
}

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

export function registerRestoredRunDeadlineSettlementTests({
  getRegistry,
  mocks,
  hydrateAndActivateRegistry,
}: {
  getRegistry: () => SubagentRegistryHarness;
  mocks: Pick<
    ReturnType<typeof createSubagentRegistryMockState>,
    | "resolveAgentTimeoutMs"
    | "restoreSubagentRunsFromDisk"
    | "callGateway"
    | "runSubagentAnnounceFlow"
  >;
  hydrateAndActivateRegistry: () => void;
}): void {
  const findRequesterRun = (runId: string) =>
    getRegistry()
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === runId);
  it.each([
    {
      name: "prefers explicit run timeout over late restored agent.wait success",
      runId: "run-resumed-late-success",
      task: "resume after explicit timeout",
      waitStartedAfterMs: 0,
      waitEndedAfterMs: 61_000,
      expected: { status: "timeout", startedAfterMs: 0, endedAfterMs: 60_000, elapsedMs: 60_000 },
      label: "late restored wait success timeout outcome",
    },
    {
      name: "uses observed agent.wait start time when applying explicit run deadline",
      runId: "run-resumed-observed-start",
      task: "respect observed start",
      waitStartedAfterMs: 10_000,
      waitEndedAfterMs: 65_000,
      expected: { status: "ok", startedAfterMs: 10_000, endedAfterMs: 65_000, elapsedMs: 55_000 },
      label: "observed start success outcome",
    },
  ] as const)(
    "$name",
    async ({ runId, task, waitStartedAfterMs, waitEndedAfterMs, expected, label }) => {
      const createdAt = Date.parse("2026-03-24T11:59:00Z");
      vi.setSystemTime(createdAt + waitEndedAfterMs);
      mocks.resolveAgentTimeoutMs.mockReturnValue(60_000);
      mocks.restoreSubagentRunsFromDisk.mockImplementation(((params: {
        runs: Map<string, unknown>;
        mergeOnly?: boolean;
      }) => {
        params.runs.set(
          runId,
          createSubagentRunRecord({
            runId,
            task,
            runTimeoutSeconds: 60,
            createdAt,
            startedAt: createdAt,
            sessionStartedAt: createdAt,
          }),
        );
        return 1;
      }) as never);
      mockGatewayMethods(mocks.callGateway, {
        "agent.wait": {
          status: "ok",
          startedAt: createdAt + waitStartedAfterMs,
          endedAt: createdAt + waitEndedAfterMs,
        },
      });

      const settleRootWork = observeRootWork();
      try {
        hydrateAndActivateRegistry();

        await waitForFast(() => {
          const completedRun = findRequesterRun(runId);
          expect(completedRun?.execution.endedAt).toBe(createdAt + expected.endedAfterMs);
          expectRecordFields(
            completedRun?.execution.outcome,
            {
              status: expected.status,
              startedAt: createdAt + expected.startedAfterMs,
              endedAt: createdAt + expected.endedAfterMs,
              elapsedMs: expected.elapsedMs,
            },
            label,
          );
        });
      } finally {
        await settleRootWork();
      }
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    },
  );
}

export function registerRestartDrainCompletionSettlementTest({
  getRegistry,
  mocks,
  findRequesterRun,
}: {
  getRegistry: () => SubagentRegistryHarness;
  mocks: Pick<ReturnType<typeof createSubagentRegistryMockState>, "runSubagentAnnounceFlow">;
  findRequesterRun: (runId: string) => SubagentRunRecord | undefined;
}): void {
  it("retries a terminal completion deferred by restart drain", async () => {
    const mod = getRegistry();
    const now = Date.now();
    const runId = "run-terminal-restart-retry";
    mod.addSubagentRunForTests({
      runId,
      childSessionKey: "agent:main:subagent:terminal-restart-retry",
      task: "deliver terminal completion after restart",
      expectsCompletionMessage: true,
      createdAt: now - 10_000,
      startedAt: now - 9_000,
      endedAt: now - 1_000,
      endedReason: SUBAGENT_ENDED_REASON_ERROR,
      outcome: { status: "error", error: "provider interrupted" },
    });

    markGatewayRestartDraining();
    await expect(
      mod.finalizeInterruptedSubagentRun({
        runId,
        error: "provider interrupted",
        endedAt: now - 1_000,
      }),
    ).resolves.toBe(1);
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();

    resetGatewayWorkAdmission();
    const settleRootWork = observeRootWork();
    try {
      await vi.advanceTimersByTimeAsync(1_000);
    } finally {
      await settleRootWork();
    }
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledOnce();
    const entry = findRequesterRun(runId);
    expect(entry?.cleanupCompletedAt).toBeTypeOf("number");
  });
}

export function registerForcedCollectorCompletionSettlementTests({
  getRegistry,
  mocks,
  findRequesterRun,
  getLifecycleHandler,
  mockPendingAgentWait,
}: {
  getRegistry: () => SubagentRegistryHarness;
  mocks: Pick<
    ReturnType<typeof createSubagentRegistryMockState>,
    "callGateway" | "entries" | "runSubagentAnnounceFlow"
  >;
  findRequesterRun: (runId: string) => SubagentRunRecord | undefined;
  getLifecycleHandler: () => (event: Pick<AgentEventPayload, "runId" | "stream" | "data">) => void;
  mockPendingAgentWait: () => void;
}): void {
  it.each([
    { observation: "lifecycle", schema: false, captured: false },
    { observation: "wait", schema: false, captured: false },
    { observation: "lifecycle", schema: true, captured: false },
    { observation: "wait", schema: true, captured: false },
    { observation: "lifecycle", schema: true, captured: true },
    { observation: "wait", schema: true, captured: true },
  ])(
    "settles forced collector yield through $observation (schema=$schema, captured=$captured)",
    async ({ observation, schema, captured }) => {
      const mod = getRegistry();
      const runId = "forced-collector-yield";
      const childSessionKey = "agent:main:subagent:forced-collector-yield";
      const terminal = {
        status: "ok",
        startedAt: 111,
        endedAt: 222,
        yielded: true,
        livenessState: "paused",
      };
      const waitResult = createDeferred<Record<string, unknown>>();
      if (observation === "wait") {
        mocks.callGateway.mockImplementation(async () => waitResult.promise);
      } else {
        mockPendingAgentWait();
      }
      mocks.entries = {
        [childSessionKey]: createSessionEntry({ lifecycleRevision: "forced-yield" }),
      };
      const settleRootWork = observeRootWork();
      try {
        await mod.registerSubagentRun({
          runId,
          childSessionKey,
          task: "force the terminal boundary",
          collect: true,
          expectsCompletionMessage: false,
          swarmRequesterSessionKey: "agent:main:main",
          ...(schema ? { outputSchema: { type: "object" } } : {}),
        });
        if (captured) {
          mod.recordSwarmStructuredOutput(
            { runId, childSessionKey },
            { invalidAttempts: 0, structured: { answer: 42 } },
          );
        }
        if (observation === "wait") {
          waitResult.resolve(terminal);
        } else {
          getLifecycleHandler()({
            runId,
            stream: "lifecycle",
            data: { phase: "end", ...terminal },
          });
        }
        await vi.advanceTimersByTimeAsync(0);
      } finally {
        await settleRootWork();
      }
      const entry = findRequesterRun(runId);
      expect(entry?.execution.status).toBe("terminal");
      expect(entry?.collectorCompletion?.status).toBe(schema && !captured ? "failed" : "done");
      expect(entry?.pauseReason).toBeUndefined();
      if (captured) {
        expect(entry?.collectorCompletion?.structured).toEqual({ answer: 42 });
      } else if (schema) {
        expect(entry?.collectorCompletion?.schemaError).toBe("structured_output was not called");
      }
      expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
    },
  );
}
