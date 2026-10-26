import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi, type Mock } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { withSessionEntryReadOnlyInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
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
  waitForFast,
  type SubagentRegistryHarness,
} from "../../subagent-test-fixtures.test-helpers.js";
import type { maybeWakeRequesterAfterAllChildrenSettled } from "../announce/subagent-announce.requester-settle-wake.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import type { createSubagentRegistryMockState } from "./subagent-registry.mock-state.test-support.js";
import { prepareSubagentRecoveryFixture } from "./subagent-registry.persistence.test-support.js";
import { makeQueuedRun } from "./subagent-registry.run-fixtures.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { isSameSubagentRun } from "./subagent-run-generation.js";

type RegistryFixture<Keys extends keyof ReturnType<typeof createSubagentRegistryMockState>> = {
  mocks: Pick<ReturnType<typeof createSubagentRegistryMockState>, Keys>;
  hydrateAndActivateRegistry: () => Promise<void>;
};
type RestoreRuns = { mockRestoredRuns: (createEntries: () => SubagentRunRecord[]) => void };

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

export async function activateSubagentRegistryWithRecoveryRuntime(
  mod: SubagentRegistryHarness,
  recoveryRuntime: GatewayRecoveryRuntime,
): Promise<void> {
  const gatewayContext = {
    recoveryRuntime,
    trackExecution: trackAsyncWork,
    resolveGatewayContext: () => gatewayContext as never,
  };
  bindGatewayContextResolver(recoveryRuntime, gatewayContext.resolveGatewayContext);
  await mod.activateSubagentRegistry(gatewayContext.resolveGatewayContext).settled;
}

export function registerRestoredRollbackPublicationTest({
  mocks,
  hydrateAndActivateRegistry,
  mockSingleCollectorConcurrency,
  mockRestoredRuns,
}: RegistryFixture<"entries" | "persistRegistryRows" | "callGateway"> &
  RestoreRuns & {
    mockSingleCollectorConcurrency: () => void;
  }): void {
  it("holds restored rollback for publication and cleanup without relaunching", async () => {
    vi.useRealTimers();
    const now = Date.now();
    mockSingleCollectorConcurrency();
    const identities = ["one", "two"].map((sessionId) => ({
      sessionId,
      lifecycleRevision: `revision-${sessionId}`,
    }));
    mockRestoredRuns(() =>
      identities.map((identity, index) =>
        makeQueuedRun({
          runId: `run-restored-stop-${identity.sessionId}`,
          childSessionIdentity: { ...identity },
          groupId: "restore-stop",
          createdAt: now + index,
        }),
      ),
    );
    mocks.entries = Object.fromEntries(
      identities.map((identity) => [
        `agent:main:subagent:run-restored-stop-${identity.sessionId}`,
        { ...identity, updatedAt: now },
      ]),
    );
    let agentCalls = 0;
    const dispatchedSessionKeys: unknown[] = [];
    const launchEntered = createDeferred();
    const releaseLaunch = createDeferred();
    let releaseAbort: (() => void) | undefined;
    const deleteReleases: Array<() => void> = [];
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
    expect(
      mocks.callGateway.mock.calls.find(([request]) => request.method === "sessions.delete")?.[0]
        .params,
    ).toMatchObject({
      key: "agent:main:subagent:run-restored-stop-one",
      expectedSessionId: "one",
      expectedLifecycleRevision: "revision-one",
    });
    deleteReleases[0]?.();
    await waitForFast(() => expect(deleteReleases).toHaveLength(2));
    expect(agentCalls).toBe(1);
    deleteReleases[1]?.();
    await waitForFast(() => expect(agentCalls).toBe(2));
    expect(dispatchedSessionKeys).toEqual([
      "agent:main:subagent:run-restored-stop-one",
      "agent:main:subagent:run-restored-stop-two",
    ]);
    expect(
      mocks.callGateway.mock.calls.filter(([request]) => request.method === "chat.abort"),
    ).toHaveLength(1);
  });
}

export function registerRestoredSessionReadTests({
  mocks,
  hydrateAndActivateRegistry,
  mockPendingAgentWait,
}: RegistryFixture<
  "entries" | "callGateway" | "mockRestoredRuns" | "withSessionEntryReadOnlyInWorker"
> & {
  mockPendingAgentWait: () => void;
}): void {
  it("routes restored waits for newer runs without reopening completed child sessions", async () => {
    const active = createSubagentRunRecord({
      runId: "run-restored-active",
      childSessionIdentity: {
        sessionId: "sess-child",
        lifecycleRevision: "revision-child",
      },
      execution: {
        status: "running",
        lifecycleGeneration: "retired-generation",
      },
    });
    mocks.entries = {
      "agent:main:subagent:child": createSessionEntry({
        lifecycleRevision: "revision-child",
        lifecycleRunId: "newer-run",
        abortedLastRun: false,
      }),
    };
    const completed = createSubagentRunRecord({
      runId: "run-restored-completed",
      childSessionKey: "agent:main:subagent:completed",
      execution: {
        status: "terminal",
        endedAt: Date.now() - 1_000,
        outcome: { status: "ok" },
      },
      cleanupCompletedAt: Date.now(),
    });
    mocks.mockRestoredRuns(() => [completed, active]);
    const readSession = mocks.withSessionEntryReadOnlyInWorker;
    vi.mocked(withSessionEntryReadOnlyInWorker).mockImplementation((...args) => {
      if (args[0].sessionKey === completed.childSessionKey) {
        throw new Error("completed child store is unavailable");
      }
      return readSession(...args);
    });
    mockPendingAgentWait();

    await hydrateAndActivateRegistry();

    expect(mocks.callGateway).toHaveBeenCalledOnce();
    expect(mocks.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "agent.wait",
        params: expect.objectContaining({ runId: active.runId }),
      }),
    );
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
  it.each(["after Gateway closure", "partial restore", "without instance binding"])(
    "replays a past-due requester-settle obligation restored %s",
    async (restoreTiming) => {
      const mod = getRegistry();
      const endedAt = Date.now() - 1_000;
      const runIds =
        restoreTiming === "partial restore"
          ? ["run-settle-restore", "run-settle-sibling"]
          : ["run-settle-restore"];
      const restored = runIds.map((runId) =>
        createSubagentRunRecord({
          runId,
          childSessionKey: `agent:main:subagent:${runId}`,
          childSessionIdentity: {
            sessionId: `session-${runId}`,
            lifecycleRevision: `revision-${runId}`,
          },
          requesterAgentId: "main",
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
      type RestoreParams = { runs: Map<string, SubagentRunRecord> };
      mocks.restoreSubagentRunsFromDisk.mockImplementation((async ({ runs }: RestoreParams) => {
        let inserted = 0;
        for (const entry of restored) {
          if (!runs.has(entry.runId)) {
            runs.set(entry.runId, entry);
            inserted += 1;
          }
        }
        return inserted;
      }) as never);
      mocks.restoreSubagentRunsFromDisk.mockImplementationOnce((async ({ runs }: RestoreParams) => {
        if (restoreTiming === "partial restore") {
          runs.set(restored[0]!.runId, restored[0]!);
        }
        throw new Error("transient sqlite read failure");
      }) as never);
      const retirementWrites: string[][] = [];
      mocks.persistRegistryRows.mockImplementation((runs, ids) => {
        if (runIds.every((id) => ids.includes(id) && !runs.has(id))) {
          retirementWrites.push(ids.toSorted());
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
        await mod.activateSubagentRegistry(resolveGatewayContext).settled;
        await mod.activateSubagentRegistry(resolveGatewayContext).settled;
        expect(wakeRequester).not.toHaveBeenCalled();
        if (restoreTiming === "partial restore") {
          await mod.testing.runSweeperTickForTests();
          expect(wakeRequester).not.toHaveBeenCalled();
        }
        gatewayOpen = restoreTiming !== "after Gateway closure";
        await mod.initSubagentRegistry();
        await mod.activateSubagentRegistry(resolveGatewayContext).settled;
        await vi.advanceTimersByTimeAsync(1_000);
        if (!gatewayOpen || restoreTiming === "without instance binding") {
          await vi.advanceTimersByTimeAsync(5_000);
          expect(wakeRequester).not.toHaveBeenCalled();
          expect(getGatewayContextResolver(restored[0]!)).toBeUndefined();
          expect(restored[0]!.requesterSettleWake?.attemptCount).toBe(1);
          await activateRegistry();
        }
        const outcome = await wakeOutcome;
        if ("error" in outcome) {
          throw outcome.error;
        }
        expect(outcome.gateway).toBe(recoveryRuntime);
      } finally {
        await settleRootWork();
      }
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(retirementWrites).toEqual([runIds.toSorted()]);
      for (const entry of restored) {
        expect(getGatewayContextResolver(entry)).toBe(getGatewayContextResolver(restored[0]!));
        expect(mod.getSubagentRunByRunId(entry.runId)).toBeUndefined();
      }
      expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
    },
  );
}

export function registerRestoredLegacyAuthorityTests({
  getRegistry,
  mocks,
  hydrateAndActivateRegistry,
  mockRestoredRuns,
}: RegistryFixture<"entries" | "callGateway" | "runSubagentAnnounceFlow"> &
  RestoreRuns & {
    getRegistry: () => SubagentRegistryHarness;
  }): void {
  it("resumes a restored legacy terminal announcement without child-session effects", async () => {
    const mod = getRegistry();
    const endedAt = Date.now() - 1_000;
    const entry = createSubagentRunRecord({
      runId: "restored-legacy-announcement",
      childSessionIdentity: undefined,
      cleanup: "keep",
      endedAt,
      outcome: { status: "ok" },
      expectsCompletionMessage: true,
      completion: { required: true, resultText: "persisted legacy result" },
      delivery: { status: "pending" },
    });
    const currentChild = {
      sessionId: "legacy-current-child",
      lifecycleRevision: "legacy-current-revision",
      updatedAt: Date.now(),
    };
    mocks.entries[entry.childSessionKey] = currentChild;
    await prepareSubagentRecoveryFixture(entry, { entries: mocks.entries });
    mockRestoredRuns(() => [entry]);

    await hydrateAndActivateRegistry();
    await waitForFast(() => expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledOnce());
    await waitForFast(() =>
      expect(mod.getSubagentRunByRunId(entry.runId)).toMatchObject({
        delivery: { status: "delivered" },
        cleanupCompletedAt: expect.any(Number),
      }),
    );

    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        childRunId: entry.runId,
        suppressChildSessionEffects: true,
      }),
    );
    expect(
      mocks.callGateway.mock.calls.some(([request]) => request.method === "sessions.delete"),
    ).toBe(false);
    expect(mod.getSubagentRunByRunId(entry.runId)?.childSessionIdentity).toBeUndefined();
    expect(mocks.entries[entry.childSessionKey]).toEqual(currentChild);
  });

  it.each([false, true])(
    "settles restored queued launch failures without a lifecycle revision once (descriptor: %s)",
    async (hasDescriptor) => {
      const mod = getRegistry();
      const entry = makeQueuedRun({
        runId: "restored-legacy-queued-failure",
        childSessionIdentity: { sessionId: "legacy-queued-session" },
        groupId: "legacy-queued",
        createdAt: Date.now(),
      });
      if (!hasDescriptor) {
        entry.queuedLaunch = undefined;
      }
      mocks.entries[entry.childSessionKey] = {
        sessionId: "legacy-queued-session",
        updatedAt: Date.now(),
      };
      mockRestoredRuns(() => [entry]);

      await hydrateAndActivateRegistry();
      await waitForFast(() =>
        expect(mod.getSubagentRunByRunId(entry.runId)).toMatchObject({
          execution: { status: "terminal", suppressSessionEffects: true },
          collectorCompletion: { status: "failed" },
          collectorLaunchCleanupPending: false,
          cleanupCompletedAt: expect.any(Number),
        }),
      );
      await hydrateAndActivateRegistry();

      expect(
        mocks.callGateway.mock.calls.some(([request]) => request.method === "sessions.delete"),
      ).toBe(false);
      expect(mocks.callGateway.mock.calls.some(([request]) => request.method === "agent")).toBe(
        false,
      );
      expect(mocks.entries[entry.childSessionKey]?.sessionId).toBe("legacy-queued-session");
    },
  );
}
