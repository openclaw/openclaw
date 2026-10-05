import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi, type Mock } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ChatAbortControllerEntry } from "../../../gateway/chat-abort.types.js";
import type { GatewayRecoveryRuntime } from "../../../gateway/server-instance-runtime.types.js";
import type { deleteGatewaySession } from "../../../gateway/server-methods/sessions-delete.js";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver,
  getSharedGatewayContextResolver,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { getActiveGatewayRootWorkCount } from "../../../process/gateway-work-admission.js";
import { trackAsyncWork } from "../../../shared/async-work-scope.js";
import {
  createSessionEntry,
  createSubagentRunRecord,
  mockGatewayMethods,
  waitForFast,
  type SubagentRegistryHarness,
} from "../../subagent-test-fixtures.test-helpers.js";
import type { maybeWakeRequesterAfterAllChildrenSettled } from "../announce/subagent-announce.requester-settle-wake.js";
import { SUBAGENT_ENDED_REASON_COMPLETE } from "./subagent-lifecycle-events.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import type { createSubagentRegistryMockState } from "./subagent-registry.mock-state.test-support.js";
import { makeQueuedRun } from "./subagent-registry.run-fixtures.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { isSameSubagentRun } from "./subagent-run-generation.js";

vi.mock("../../../gateway/server-methods/sessions-delete.js", () => ({
  deleteGatewaySession: async ({
    params,
    context,
    assertCurrent,
  }: Parameters<typeof deleteGatewaySession>[0]): ReturnType<typeof deleteGatewaySession> => {
    // Both deletion entry points share this host fixture's controlled completion.
    assertCurrent?.();
    await expectDefined(context.recoveryRuntime, "fixture lifecycle runtime").dispatchSessionMethod(
      "sessions.delete",
      params,
      { assertCurrent },
    );
    assertCurrent?.();
    return { ok: true, result: { ok: true, key: params.key, deleted: true, archived: [] } };
  },
}));

type RestoredSettlementTestOptions = {
  getRegistry: () => SubagentRegistryHarness;
  mocks: Pick<
    ReturnType<typeof createSubagentRegistryMockState>,
    | "entries"
    | "restoreSubagentRunsFromDisk"
    | "callGateway"
    | "runSubagentAnnounceFlow"
    | "dispatchRecoveryAgent"
  >;
  hydrateAndActivateRegistry: () => Promise<void>;
};

export async function activateSubagentRegistryWithRecoveryRuntime(
  mod: SubagentRegistryHarness,
  recoveryRuntime: GatewayRecoveryRuntime,
): Promise<void> {
  const gatewayContext = {
    chatAbortControllers: new Map<string, ChatAbortControllerEntry>(),
    recoveryRuntime,
    trackExecution: trackAsyncWork,
    resolveGatewayContext: () => gatewayContext as never,
  };
  bindGatewayContextResolver(recoveryRuntime, gatewayContext.resolveGatewayContext);
  await mod.activateSubagentRegistry(gatewayContext.resolveGatewayContext);
}

export function registerRestoredRunningSettlementTest({
  getRegistry,
  mocks,
  hydrateAndActivateRegistry,
}: RestoredSettlementTestOptions): void {
  it.each(["done"] as const)(
    "settles and announces a retired running row whose saved session completed as %s",
    async (status) => {
      const mod = getRegistry();
      const findRequesterRun = (runId: string) =>
        mod.listSubagentRunsForRequester("agent:main:main").find((entry) => entry.runId === runId);
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
        const restored = createSubagentRunRecord({
          runId,
          childSessionKey,
          task: "saved completion",
          createdAt: startedAt,
          execution: { status: "running", startedAt, lifecycleGeneration: "retired-generation" },
        });
        mocks.restoreSubagentRunsFromDisk.mockImplementation(async (params) => {
          params.runs.set(runId, restored);
          return 1;
        });
        mockGatewayMethods(mocks.callGateway, { "agent.wait": { status: "timeout" } });

        await hydrateAndActivateRegistry();

        await announceEntered.promise;
        await settleRootWork(true);
        expect(findRequesterRun(runId)).toMatchObject({
          execution: { status: "terminal", endedAt, outcome: { status: "ok" } },
          endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
          delivery: { status: "delivered" },
        });
        expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            childRunId: runId,
            outcome: expect.objectContaining({ status: "ok" }),
          }),
        );
        expect(mocks.dispatchRecoveryAgent).not.toHaveBeenCalled();
      } finally {
        await settleRootWork();
      }
    },
  );
}

export function registerRestoredRollbackPublicationTest({
  mocks,
  hydrateAndActivateRegistry,
  mockSingleCollectorConcurrency,
  mockRestoredRuns,
}: {
  mocks: Pick<
    ReturnType<typeof createSubagentRegistryMockState>,
    "entries" | "persistRegistryRows" | "callGateway" | "emitSessionLifecycleEvent"
  >;
  hydrateAndActivateRegistry: () => Promise<void>;
  mockSingleCollectorConcurrency: () => void;
  mockRestoredRuns: (createEntries: () => SubagentRunRecord[]) => void;
}): void {
  it("holds restored rollback for publication and retries settlement without relaunching", async () => {
    vi.useRealTimers();
    const now = Date.now();
    mockSingleCollectorConcurrency();
    mockRestoredRuns(() => [
      makeQueuedRun({ runId: "run-restored-stop-one", groupId: "restore-stop", createdAt: now }),
      makeQueuedRun({
        runId: "run-restored-stop-two",
        groupId: "restore-stop",
        createdAt: now + 1,
      }),
    ]);
    mocks.entries = {
      "agent:main:subagent:run-restored-stop-one": {
        sessionId: "one",
        lifecycleRevision: "revision-one",
        updatedAt: now,
      },
      "agent:main:subagent:run-restored-stop-two": { sessionId: "two", updatedAt: now },
    };
    let agentCalls = 0;
    const dispatchedSessionKeys: unknown[] = [];
    const launchEntered = createDeferred();
    const releaseLaunch = createDeferred();
    let releaseAbort: (() => void) | undefined;
    const deleteReleases: Array<() => void> = [];
    let deletionPublicationFailed = false;
    mocks.callGateway.mockImplementation(async (request) => {
      if (request.method === "agent") {
        agentCalls += 1;
        dispatchedSessionKeys.push(request.params?.sessionKey);
        if (agentCalls === 1) {
          launchEntered.resolve();
          await releaseLaunch.promise;
        }
        return { runId: `gateway-restored-${agentCalls}` };
      }
      if (request.method === "chat.abort") {
        return await new Promise<Record<string, unknown>>((resolve) => {
          releaseAbort = () => resolve({});
        });
      }
      if (request.method === "sessions.delete") {
        return await new Promise<Record<string, unknown>>((resolve) => {
          deleteReleases.push(() => resolve({}));
        });
      }
      return request.method === "agent.wait" ? { status: "pending" } : {};
    });

    await hydrateAndActivateRegistry();
    await launchEntered.promise;
    mocks.persistRegistryRows.mockImplementationOnce(() => {
      throw new Error("sqlite unavailable after Gateway acceptance");
    });
    const memory = await import("./subagent-registry-memory.js");
    const entry = expectDefined(memory.subagentRuns.get("run-restored-stop-one"), "restored run");
    const publication = memory.subagentRuns.captureRetirement(entry, (current) =>
      isSameSubagentRun(current, entry),
    );
    const overlap = memory.subagentRuns.captureRetirement(entry, (current) =>
      isSameSubagentRun(current, entry),
    );
    const cleanupWaiting = createDeferred();
    const waitForPublication = memory.waitForSubagentRetirementPublication;
    const publicationWait = vi
      .spyOn(memory, "waitForSubagentRetirementPublication")
      .mockImplementation((current) => {
        const pending = waitForPublication(current);
        if (isSameSubagentRun(current, entry) && pending) {
          cleanupWaiting.resolve();
        }
        return pending;
      });
    try {
      releaseLaunch.resolve();
      await cleanupWaiting.promise;
      expect(releaseAbort).toBeUndefined();
      expect(deleteReleases).toEqual([]);
      expect(agentCalls).toBe(1);
      publication.completePublication();
      expect(memory.hasPendingSubagentRetirementPublication(entry)).toBe(true);
      expect(releaseAbort).toBeUndefined();
      overlap.completePublication();
    } finally {
      releaseLaunch.resolve();
      publication.release();
      overlap.release();
      publicationWait.mockRestore();
    }
    await waitForFast(() => expect(releaseAbort).toBeTypeOf("function"));
    expect(agentCalls).toBe(1);

    releaseAbort?.();
    await waitForFast(() => expect(deleteReleases).toHaveLength(1));
    expect(agentCalls).toBe(1);
    await waitForFast(() =>
      expect(mocks.callGateway).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "sessions.delete",
          params: expect.objectContaining({
            key: "agent:main:subagent:run-restored-stop-one",
            expectedSessionId: "one",
            expectedLifecycleRevision: "revision-one",
          }),
        }),
      ),
    );
    deleteReleases[0]?.();
    await waitForFast(() => expect(deleteReleases).toHaveLength(2));
    expect(agentCalls).toBe(1);
    mocks.emitSessionLifecycleEvent.mockImplementationOnce(({ reason }: { reason: string }) => {
      expect(reason).toBe("delete");
      deletionPublicationFailed = true;
      throw new Error("restored deletion publication failed");
    });
    deleteReleases[1]?.();
    await waitForFast(() => expect(agentCalls).toBe(2));
    expect(deletionPublicationFailed).toBe(true);
    expect(dispatchedSessionKeys).toEqual([
      "agent:main:subagent:run-restored-stop-one",
      "agent:main:subagent:run-restored-stop-two",
    ]);
    expect(
      mocks.callGateway.mock.calls.filter(([request]) => request.method === "chat.abort"),
    ).toHaveLength(1);
  });
}

export function registerRestoredRequesterWakeSettlementTests({
  getRegistry,
  mocks,
  wakeRequester,
  bindWakeMutation,
  activateRegistry,
  recoveryRuntime,
}: {
  getRegistry: () => SubagentRegistryHarness;
  mocks: Pick<
    ReturnType<typeof createSubagentRegistryMockState>,
    "restoreSubagentRunsFromDisk" | "persistRegistryRows" | "runSubagentAnnounceFlow"
  >;
  wakeRequester: Mock<typeof maybeWakeRequesterAfterAllChildrenSettled>;
  bindWakeMutation: (entries: readonly SubagentRunRecord[]) => void;
  activateRegistry: () => Promise<void>;
  recoveryRuntime: GatewayRecoveryRuntime;
}): void {
  it.each([
    "after Gateway closure",
    "partial restore",
    "without instance binding",
    "without activation",
  ])("replays a past-due requester-settle obligation restored %s", async (restoreTiming) => {
    const mod = getRegistry();
    const endedAt = Date.now() - 1_000;
    const lateRestore = !["before activation", "without activation"].includes(restoreTiming);
    const runIds =
      restoreTiming === "partial restore"
        ? ["run-settle-restore", "run-settle-sibling"]
        : ["run-settle-restore"];
    const restored = runIds.map((runId) =>
      createSubagentRunRecord({
        runId,
        childSessionKey: `agent:main:subagent:${runId}`,
        requesterAgentId: "main",
        task: "restore requester settle wake",
        cleanup: "delete",
        expectsCompletionMessage: true,
        createdAt: endedAt - 1_000,
        startedAt: endedAt - 900,
        endedAt,
        cleanupCompletedAt: endedAt,
        completion: { required: true, resultText: "persisted findings" },
        delivery: { status: "delivered" },
        requesterSettleWake: {
          status: "pending",
          attemptCount: 1,
          nextAttemptAt: endedAt,
          batchRunIds: runIds,
          retireAfterSettle: true,
        },
      }),
    );
    mocks.restoreSubagentRunsFromDisk.mockImplementation((async (params: {
      runs: Map<string, SubagentRunRecord>;
    }) => {
      let inserted = 0;
      for (const entry of restored) {
        if (!params.runs.has(entry.runId)) {
          params.runs.set(entry.runId, entry);
          inserted += 1;
        }
      }
      return inserted;
    }) as never);
    if (lateRestore) {
      mocks.restoreSubagentRunsFromDisk.mockImplementationOnce((async (params: {
        runs: Map<string, SubagentRunRecord>;
      }) => {
        if (restoreTiming === "partial restore") {
          params.runs.set(restored[0]!.runId, restored[0]!);
        }
        throw new Error("transient sqlite read failure");
      }) as never);
    }
    const settlementWrites: string[][] = [];
    mocks.persistRegistryRows.mockImplementation((runs, ids) => {
      if (
        runIds.every((id) => ids.includes(id) && runs.has(id) && !runs.get(id)?.requesterSettleWake)
      ) {
        settlementWrites.push(ids.toSorted());
      }
    });
    const wakeGateway = createDeferred<unknown>();
    const wakeOutcome = wakeGateway.promise.then(
      (gateway) => ({ gateway }),
      (error: unknown) => ({ error }),
    );
    wakeRequester.mockImplementation(async (params) => {
      try {
        const gateway = getSharedGatewayContextResolver(restored)?.()?.recoveryRuntime;
        bindWakeMutation(restored);
        await params.completeBatch(restored);
        wakeGateway.resolve(gateway);
        return false;
      } catch (error) {
        wakeGateway.reject(error);
        throw error;
      }
    });
    let gatewayOpen = true;
    const instanceContext = {
      chatAbortControllers: new Map<string, ChatAbortControllerEntry>(),
      recoveryRuntime,
    } as never;
    const resolveInstance = () => (gatewayOpen ? instanceContext : undefined);
    const resolveGatewayContext = () =>
      (restoreTiming === "without instance binding"
        ? instanceContext
        : { resolveGatewayContext: resolveInstance }) as never;
    const settleRootWork = observeRootWork();
    try {
      await mod.initSubagentRegistry();
      if (restoreTiming === "without activation") {
        mod.resumeSubagentRun(restored[0]!.runId);
      } else {
        await mod.activateSubagentRegistry(resolveGatewayContext);
        await mod.activateSubagentRegistry(resolveGatewayContext);
      }
      if (lateRestore) {
        expect(wakeRequester).not.toHaveBeenCalled();
        if (restoreTiming === "partial restore") {
          await mod.testing.runSweeperTickForTests();
          expect(wakeRequester).not.toHaveBeenCalled();
        }
        gatewayOpen = restoreTiming !== "after Gateway closure";
        await vi.advanceTimersByTimeAsync(1_000);
        if (!gatewayOpen || restoreTiming === "without instance binding") {
          await vi.advanceTimersByTimeAsync(5_000);
          expect(wakeRequester).not.toHaveBeenCalled();
          expect(getGatewayContextResolver(restored[0]!)).toBeUndefined();
          expect(restored[0]!.requesterSettleWake?.attemptCount).toBe(1);
          await activateRegistry();
        }
      }
      const outcome = await wakeOutcome;
      if ("error" in outcome) {
        throw outcome.error;
      }
      expect(outcome.gateway).toBe(
        restoreTiming === "without activation" ? undefined : recoveryRuntime,
      );
    } finally {
      await settleRootWork();
    }
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    expect(settlementWrites).toEqual([runIds.toSorted()]);
    for (const entry of restored) {
      expect(getGatewayContextResolver(entry)).toBe(getGatewayContextResolver(restored[0]!));
      expect(mod.getSubagentRunByRunId(entry.runId)).toMatchObject({
        cleanupCompletedAt: endedAt,
        delivery: { status: "delivered" },
      });
      expect(mod.getSubagentRunByRunId(entry.runId)?.requesterSettleWake).toBeUndefined();
      expect(mod.getSubagentRunByRunId(entry.runId)?.retireAfterRequesterTurn).toBeUndefined();
    }
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expect(wakeRequester).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterSessionKey: "agent:main:main",
        settledEntry: expect.objectContaining({ runId: "run-settle-restore" }),
        transitionBatch: expect.any(Function),
        completeBatch: expect.any(Function),
      }),
    );
  });
}

export function registerRestoredRotationFailureTest({
  getRegistry,
  mocks,
  hydrateAndActivateRegistry,
  mockSingleCollectorConcurrency,
  mockRestoredRuns,
}: {
  getRegistry: () => SubagentRegistryHarness;
  mocks: Pick<
    ReturnType<typeof createSubagentRegistryMockState>,
    "entries" | "persistRegistryRows" | "callGateway" | "lifecycleGeneration"
  >;
  hydrateAndActivateRegistry: () => Promise<void>;
  mockSingleCollectorConcurrency: () => void;
  mockRestoredRuns: (createEntries: () => SubagentRunRecord[]) => void;
}): void {
  it("releases restored FIFO ownership when lifecycle rotates during failure persistence", async () => {
    const mod = getRegistry();
    vi.useRealTimers();
    const now = Date.now();
    mockSingleCollectorConcurrency();
    mockRestoredRuns(() => [
      makeQueuedRun({
        runId: "run-restored-rotation-one",
        groupId: "restore-lifecycle-rotation",
        createdAt: now,
      }),
      makeQueuedRun({
        runId: "run-restored-rotation-two",
        groupId: "restore-lifecycle-rotation",
        createdAt: now + 1,
      }),
    ]);
    mocks.entries = {
      "agent:main:subagent:run-restored-rotation-one": {
        sessionId: "one",
        lifecycleRevision: "revision-one",
        updatedAt: now,
      },
      "agent:main:subagent:run-restored-rotation-two": {
        sessionId: "two",
        lifecycleRevision: "revision-two",
        updatedAt: now,
      },
    };
    let persistenceCalls = 0;
    let concurrentSweep: Promise<void> | undefined;
    let agentCalls = 0;
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent") {
        agentCalls += 1;
        if (agentCalls === 1) {
          mocks.persistRegistryRows.mockImplementation(() => {
            persistenceCalls += 1;
            if (persistenceCalls === 1) {
              throw new Error("sqlite unavailable after Gateway acceptance");
            }
            if (persistenceCalls === 2) {
              mocks.lifecycleGeneration = "rotated-generation";
              concurrentSweep = mod.testing.sweepOnceForTests();
              throw new Error("sqlite unavailable during failure settlement");
            }
          });
        }
        return { runId: `gateway-restored-rotation-${agentCalls}` };
      }
      return request.method === "agent.wait" ? { status: "pending" } : {};
    });

    await hydrateAndActivateRegistry();

    await waitForFast(() => expect(persistenceCalls).toBeGreaterThanOrEqual(3));
    await concurrentSweep;
    await waitForFast(() => expect(agentCalls).toBe(2));
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    expect(mod.getSubagentRunByRunId("run-restored-rotation-one")).toMatchObject({
      execution: {
        status: "terminal",
        suppressSessionEffects: true,
        outcome: { status: "error" },
      },
      collectorCompletion: { status: "failed" },
    });
    expect(mod.getSubagentRunByRunId("gateway-restored-rotation-2")).toMatchObject({
      execution: { status: "running", lifecycleGeneration: "rotated-generation" },
    });
  });
}
