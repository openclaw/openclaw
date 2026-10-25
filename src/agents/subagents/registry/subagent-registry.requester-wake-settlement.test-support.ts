import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, onTestFinished, vi, type Mock } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../../test/helpers/promise.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { resolveRuntimeWorkerUrl } from "../../../infra/runtime-worker-url.js";
import { workerTaskPoolEntrypoints } from "../../../infra/worker-task-pool-runtime.test-support.js";
import { WorkerTaskPool } from "../../../infra/worker-task-pool.js";
import {
  getExistingSessionControllerMailbox,
  retireSessionControllerInput,
} from "../../../sessions/session-controller.mailbox.js";
import { captureSessionTarget } from "../../../sessions/session-controller.target.js";
import {
  assertAgentDatabaseAdmitted,
  recordAgentDatabaseAdmissions,
} from "../../../state/agent-database-admission.js";
import { withAgentDatabaseStartupAdmission } from "../../../state/agent-database-startup.js";
import { openOpenClawAgentDatabase } from "../../../state/openclaw-agent-db.js";
import {
  createSubagentRunParams,
  createSubagentRunRecord,
} from "../../subagent-test-fixtures.test-helpers.js";
import * as deliveryRuntime from "../announce/subagent-announce-delivery.runtime.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "../announce/subagent-announce.requester-settle-wake.js";
import { mutateRequesterCompletionBatch } from "../completion/subagent-completion-admission.store.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import { buildScopedSubagentRunReadIndexFromRuns } from "./subagent-registry-queries.js";
import type { GatewayRequest } from "./subagent-registry.lifecycle-fixture.test-support.js";
import { prepareSubagentRecoveryFixture } from "./subagent-registry.persistence.test-support.js";
import {
  createRequesterYieldTool,
  visibleChild,
} from "./subagent-registry.requester-wake-receipts.test-support.js";
import type { RequesterWakeFixture } from "./subagent-registry.requester-wake-session.test-support.js";
import * as registry from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function holdWorkerCapacity() {
  const pool = new WorkerTaskPool<void, undefined>({
    workerUrl: resolveRuntimeWorkerUrl(workerTaskPoolEntrypoints.worker),
    maxWorkers: 1,
    maxPendingTasks: 1,
  });
  const preparation = createDeferred();
  const controller = new AbortController();
  // Hold input preparation so the real pool rejects excess work without spawning a worker.
  const held = Promise.allSettled([
    pool.run(() => preparation.promise, { signal: controller.signal }),
  ]);
  const release = async () => {
    controller.abort();
    preparation.resolve();
    await held;
  };
  return {
    pool,
    release,
    async [Symbol.asyncDispose]() {
      try {
        await release();
      } finally {
        await pool.close();
      }
    },
  };
}

export function registerRequesterWakeSettlementBoundaryTests<Response>({
  requesterSessionKey,
  prepareChildSession,
  getFixture,
  wakeRequester,
  flushAsync,
  callGatewayMock,
  setReleaseAgentCallGate,
  spawnVisibleChild,
  settleTurn,
  emitCompleted,
  flushOwnedWork,
  waitForDeliveredCleanup,
  getRequesterWakeCalls,
  getAgentCalls,
  createGatewayContext,
  getLifecycleHandler,
  useGlobalSessionScope,
}: RequesterWakeFixture & {
  callGatewayMock: Mock<(request: GatewayRequest) => Promise<Response>>;
  flushAsync: () => Promise<void>;
  setReleaseAgentCallGate: (release: () => void) => void;
  useGlobalSessionScope: () => void;
}): void {
  const readWake = (runId: string) => registry.getSubagentRunByRunId(runId)?.requesterSettleWake;
  const advance = async (ms: number, count: number) => {
    await vi.advanceTimersByTimeAsync(ms);
    await flushOwnedWork();
    expect(getRequesterWakeCalls()).toHaveLength(count);
  };
  const activate = async (context?: GatewayRequestContext) => {
    await registry.initSubagentRegistry();
    const activeContext = context ?? createGatewayContext();
    await registry.activateSubagentRegistry(() => activeContext).settled;
  };
  async function restoreChild(runId: string, overrides: Partial<SubagentRunRecord>) {
    const childSessionKey = `agent:main:subagent:${runId}`;
    const { sessionId, lifecycleRevision } = await prepareChildSession(childSessionKey, runId, 1);
    const recovered = createSubagentRunRecord({
      runId,
      childSessionKey,
      childSessionIdentity: { sessionId, lifecycleRevision },
      requesterSessionKey,
      requesterAgentId: "main",
      createdAt: 1_000,
      startedAt: 2_000,
      endedAt: 3_000,
      outcome: { status: "ok" },
      expectsCompletionMessage: true,
      delivery: { status: "delivered" },
      ...overrides,
    });
    const { sessionStore, sessionStorePath } = getFixture();
    await prepareSubagentRecoveryFixture(recovered, {
      entries: sessionStore,
      storePath: sessionStorePath,
    });
    await registry.addSubagentRunForTests(recovered);
  }
  function pendingWake(
    runId: string,
    batchRunIds = [runId],
  ): NonNullable<SubagentRunRecord["requesterSettleWake"]> {
    return {
      status: "pending" as const,
      attemptCount: 0,
      batchRunIds,
      requesterYieldBatch: true,
      rearmGeneration: 1,
      progressOperationId: runId,
    };
  }
  it.for(["cohort", "individual"] as const)(
    "drains a restored %s before later cohorts when registry order differs",
    async (firstKind, { signal }) => {
      vi.setSystemTime(100_000);
      const registryOrder = ["later-a", "later-b", "first"];
      for (const [index, runId] of registryOrder.entries()) {
        const endedAt = runId === "first" ? 3_000 : 4_000 + index;
        await restoreChild(runId, {
          createdAt: 1_000 + index,
          execution: { status: "terminal", endedAt, outcome: { status: "ok" } },
          cleanupCompletedAt: endedAt,
          requesterSettleWake: pendingWake(runId),
          ...(runId === "first" && firstKind === "individual"
            ? {
                cleanupCompletedAt: undefined,
                requesterSettleWake: undefined,
                delivery: { status: "pending" },
                completion: {
                  required: true,
                  resultText: "Earlier child result",
                  capturedAt: endedAt,
                },
              }
            : {}),
        });
      }
      await registry.resetSubagentRegistryForTests({ persist: false });
      await activate();
      const mailbox = getExistingSessionControllerMailbox(
        requesterSessionKey,
        captureSessionTarget({
          storeScope: getFixture().sessionStorePath,
          sessionKey: requesterSessionKey,
        }),
      );
      try {
        await withinTest(flushOwnedWork(), signal);
        const expected = ["first", "later-a", "later-b"].map((runId) =>
          runId === "first" && firstKind === "individual"
            ? "announce:v1:agent:main:subagent:first:first"
            : `announce:requester-settle:main:${requesterSessionKey}:${runId}:yield-1`,
        );
        expect(getAgentCalls().map((request) => request.params?.idempotencyKey)).toEqual(expected);
        for (const runId of registryOrder) {
          expect(readWake(runId)).toBeUndefined();
        }
        await advance(120_000, firstKind === "individual" ? 2 : 3);
        expect(getAgentCalls().map((request) => request.params?.idempotencyKey)).toEqual(expected);
      } finally {
        for (const input of mailbox?.entries.slice() ?? []) {
          retireSessionControllerInput(input);
        }
        await flushOwnedWork();
      }
    },
  );
  it("dispatches a yielded cohort once after a second restart retires an already-delivered wave", async ({
    signal,
  }) => {
    vi.setSystemTime(100_000);
    const earlierWave = ["earlier-a", "earlier-b"];
    for (const runId of earlierWave) {
      await restoreChild(runId, {
        cleanupCompletedAt: 3_000,
        requesterSettleWake: {
          status: "pending",
          attemptCount: 1,
          nextAttemptAt: 200_000,
          batchRunIds: earlierWave,
          rearmGeneration: 1,
        },
      });
    }
    await restoreChild("yielded-child", {
      cleanupCompletedAt: 4_000,
      requesterSettleWake: { ...pendingWake("yielded-child"), nextAttemptAt: 200_000 },
    });
    await registry.resetSubagentRegistryForTests({ persist: false });
    await activate();
    await flushOwnedWork();
    expect(getRequesterWakeCalls()).toHaveLength(0);

    await registry.resetSubagentRegistryForTests({ persist: false });
    vi.setSystemTime(200_000);
    await activate();
    const mailbox = getExistingSessionControllerMailbox(
      requesterSessionKey,
      captureSessionTarget({
        storeScope: getFixture().sessionStorePath,
        sessionKey: requesterSessionKey,
      }),
    );
    try {
      await withinTest(flushOwnedWork(), signal);
      for (const runId of earlierWave) {
        expect(readWake(runId)).toBeUndefined();
      }
      expect(getRequesterWakeCalls()).toHaveLength(1);
      expect(getRequesterWakeCalls()[0]?.params?.idempotencyKey).toBe(
        `announce:requester-settle:main:${requesterSessionKey}:yielded-child:yield-1`,
      );
      expect(readWake("yielded-child")).toBeUndefined();
      await advance(120_000, 1);
    } finally {
      // A regressed raw reservation must not hold the fixture's teardown behind it.
      for (const input of mailbox?.entries.slice() ?? []) {
        retireSessionControllerInput(input);
      }
      await flushOwnedWork();
    }
  });
  it.each(["retry", "cancel", "replace"] as const)(
    "preserves a saved wake through worker capacity preparation (%s)",
    async (outcome) => {
      vi.setSystemTime(100_000);
      const runId = "preparation-child";
      await restoreChild(runId, {
        completion: {
          required: true,
          terminalReply: { disposition: "visible", text: "old result" },
          capturedAt: 3_000,
        },
        requesterSettleWake: {
          ...pendingWake(runId),
          replayCount: 0,
          progressOperationId: "original-progress",
          retireAfterSettle: true,
        },
      });
      const { sessionStorePath } = getFixture();
      const original = registry.getSubagentRunByRunId(runId)!;
      await using capacity = holdWorkerCapacity();
      const captureRequester = deliveryRuntime.captureRequesterSessionEntryCurrent;
      const read = vi
        .spyOn(deliveryRuntime, "captureRequesterSessionEntryCurrent")
        .mockImplementation(async (...args) => {
          await capacity.pool.run(undefined, {});
          return captureRequester(...args);
        });
      const context = createGatewayContext();
      await activate(context);
      const source = getExistingSessionControllerMailbox(
        requesterSessionKey,
        captureSessionTarget({
          storeScope: sessionStorePath,
          sessionKey: requesterSessionKey,
        }),
      )?.entries.find(
        (input) =>
          input.sourceTurnId === `requester-settle:main:${requesterSessionKey}:${runId}:yield-1`,
      );
      expect(source).toBeDefined();
      // Raw row replacement leaves this fixture's original reservation for its owner to retire.
      onTestFinished(() => source && retireSessionControllerInput(source));
      await flushOwnedWork();
      expect(read).toHaveBeenCalled();
      expect(getRequesterWakeCalls()).toHaveLength(0);
      const retained = registry.getSubagentRunByRunId(runId)!;
      expect(retained.requesterSettleWake).toEqual(original.requesterSettleWake);
      expect(retained.delivery).toEqual(original.delivery);
      expect(retained.suppressCompletionDelivery).not.toBe(true);
      await advance(30_000, 0);

      if (outcome === "cancel") {
        await registry.retireSubagentObligations(retained, () => {}, { requesterNotified: true });
      } else if (outcome === "replace") {
        await registry.addSubagentRunForTests({
          ...retained,
          generation: (retained.generation ?? 0) + 1,
          completion: {
            ...retained.completion!,
            terminalReply: { disposition: "visible", text: "replacement result" },
          },
          requesterSettleWake: undefined,
        });
      } else {
        // Reopen while capacity is still held: durable custody survives, readiness stays pool-owned.
        await registry.resetSubagentRegistryForTests({ persist: false });
        await activate(context);
        await flushOwnedWork();
        expect(getRequesterWakeCalls()).toHaveLength(0);
        expect(readWake(runId)).toEqual(original.requesterSettleWake);
      }
      read.mockRestore();
      await capacity.release();
      await flushOwnedWork();
      const wakes = getRequesterWakeCalls();
      expect(wakes).toHaveLength(outcome === "retry" ? 1 : 0);
      if (outcome === "retry") {
        expect(wakes[0]?.params?.idempotencyKey).toBe(
          `announce:requester-settle:main:${requesterSessionKey}:${runId}:yield-1`,
        );
        expect(wakes[0]?.params?.message).toContain("Already delivered child results");
        expect(wakes[0]?.params?.message).not.toContain("old result");
        expect(registry.getSubagentRunByRunId(runId)).toBeUndefined();
      } else if (outcome === "cancel") {
        expect(readWake(runId)).toBeUndefined();
      } else {
        expect(registry.getSubagentRunByRunId(runId)).toMatchObject({
          generation: (retained.generation ?? 0) + 1,
          completion: { terminalReply: { text: "replacement result" } },
        });
        expect(readWake(runId)).toBeUndefined();
      }
      await advance(120_000, wakes.length);
    },
  );

  it("resumes a persisted requester cohort after database startup inspection finishes", async () => {
    const { testState } = getFixture();
    vi.setSystemTime(100_000);
    const runIds = ["restored-alpha", "restored-beta"];
    const expectedWakes = runIds.map((runId, index) => ({
      ...pendingWake(runId, runIds),
      ...(index === 0 ? { retireAfterSettle: true } : {}),
    }));
    for (const [index, runId] of runIds.entries()) {
      await restoreChild(runId, {
        completion: { required: true, resultText: `${runId} findings`, capturedAt: 3_000 },
        cleanupCompletedAt: 3_000,
        requesterSettleWake: structuredClone(expectedWakes[index]),
      });
    }
    await registry.resetSubagentRegistryForTests({ persist: false });
    const pathname = openOpenClawAgentDatabase({ agentId: "main" }).path;
    for (const restart of [true, false]) {
      await withAgentDatabaseStartupAdmission(async (admission) => {
        const inspection = createDeferred<{ incompatible: []; indeterminate: [] }>();
        recordAgentDatabaseAdmissions(
          admission.defer({
            env: testState.env,
            inspections: [
              { target: { agentId: "main", path: pathname }, result: inspection.promise },
            ],
            reason: "Requester fixture is waiting for startup inspection.",
          }),
          { env: testState.env, source: "startup" },
        );
        const owner = admission.adopt();
        admission.activate({
          isCurrent: () => true,
          preparationReady: Promise.resolve(),
          openAgent: async () => {
            openOpenClawAgentDatabase({ agentId: "main" });
          },
          migrateAgent: async () => {},
          publishAgent: async () => {},
        });
        // Session reads are supplied by this suite; retain their real startup admission boundary.
        vi.mocked(maybeWakeRequesterAfterAllChildrenSettled).mockImplementation((params) => {
          assertAgentDatabaseAdmitted("main");
          return wakeRequester(params);
        });
        let activation: Promise<PromiseSettledResult<void>[]> | undefined;
        try {
          await registry.initSubagentRegistry();
          const context = createGatewayContext();
          activation = Promise.allSettled([
            registry.activateSubagentRegistry(() => context).settled,
          ]);
          await advance(30_000, 0);
          expect(runIds.map(readWake)).toEqual(expectedWakes);
          if (restart) {
            // Stop the old owner before releasing its gate; reset must not inherit live recovery.
            const stopped = owner.stop();
            inspection.resolve({ incompatible: [], indeterminate: [] });
            await stopped;
            expect(await activation).toMatchObject([
              {
                status: "rejected",
                reason: { name: "AbortError" },
              },
            ]);
          } else {
            const prepared = admission.waitForAgentPreparation("main", { env: testState.env });
            expect(prepared).toBeDefined();
            inspection.resolve({ incompatible: [], indeterminate: [] });
            await prepared;
            expect(await activation).toEqual([{ status: "fulfilled", value: undefined }]);
            await flushOwnedWork();
            expect(getRequesterWakeCalls()).toHaveLength(1);
            expect(registry.getSubagentRunByRunId(runIds[0]!)).toBeUndefined();
            expect(registry.getSubagentRunByRunId(runIds[1]!)).toBeDefined();
            for (const runId of runIds) {
              expect(readWake(runId)).toBeUndefined();
            }
            await advance(120_000, 1);
          }
        } finally {
          const stopped = owner.stop();
          inspection.resolve({ incompatible: [], indeterminate: [] });
          await stopped;
          await activation;
        }
      });
      if (restart) {
        await registry.resetSubagentRegistryForTests({ persist: false });
      }
    }
  });
  it("delivers an adopted self-yield follow-up once while ordinary announce is in flight", async () => {
    vi.setSystemTime(100_000);
    const context = createGatewayContext();
    await registry.initSubagentRegistry();
    await registry.activateSubagentRegistry(() => context).settled;
    const childSessionKey = "agent:main:subagent:self-yield-followup";
    const kickoffRunId = "run-self-yield-kickoff";
    const followupRunId = "run-self-yield-followup";
    const sessionEntry = await prepareChildSession(childSessionKey, "sess-self-yield-followup");
    const register = (runId: string, expectsCompletionMessage: boolean) =>
      registry.registerSubagentRun(
        createSubagentRunParams({
          runId,
          childSessionKey,
          sessionEntry,
          requesterAgentId: "main",
          expectsCompletionMessage,
          gatewayContextResolver: context.resolveGatewayContext,
        }),
      );
    await register(kickoffRunId, true);
    await registry.claimSubagentYield({
      runId: kickoffRunId,
      sessionKey: childSessionKey,
      agentId: "main",
      waitForMessage: true,
      hasPendingWork: () => false,
    });
    await register(followupRunId, false);
    getLifecycleHandler()!({
      stream: "lifecycle",
      runId: kickoffRunId,
      seq: 1,
      ts: Date.now(),
      sessionKey: childSessionKey,
      data: { phase: "end", endedAt: Date.now(), yielded: true },
    });
    await flushOwnedWork();

    const ordinaryEntered = createDeferred();
    const ordinaryRelease = createDeferred();
    setReleaseAgentCallGate(() => ordinaryRelease.resolve());
    const respond = callGatewayMock.getMockImplementation()!;
    callGatewayMock.mockImplementation(async (request) => {
      if (
        request.method === "agent" &&
        request.params?.idempotencyKey?.startsWith("announce:v1:")
      ) {
        ordinaryEntered.resolve();
        await ordinaryRelease.promise;
      }
      return respond(request);
    });
    const wakes = vi
      .mocked(maybeWakeRequesterAfterAllChildrenSettled)
      .mockClear()
      .mockImplementation(wakeRequester);
    emitCompleted(followupRunId, childSessionKey, "follow-up completed");
    const completion = flushOwnedWork();
    try {
      await awaitGateBeforeSettlement(
        ordinaryEntered.promise,
        completion,
        "adopted follow-up settled without an ordinary announcement",
      );
      // Join all recovery wakes started before the delivery receipt commits.
      await registry.testing.sweepOnceForTests();
      await flushAsync();
      await Promise.all(wakes.mock.results.map(({ value }) => value));
    } finally {
      ordinaryRelease.resolve();
      await completion;
    }
    await flushOwnedWork();
    expect(getAgentCalls()).toHaveLength(1);
    await waitForDeliveredCleanup(followupRunId);
  });
  const readRun = registry.getSubagentRunByRunId;
  async function settleYield(runId: string, children: ReturnType<typeof visibleChild>[]) {
    await createRequesterYieldTool(requesterSessionKey, runId).execute(runId, {});
    await settleTurn(runId, children);
  }
  const addRun = (
    runId: string,
    childSessionKey: string,
    overrides: Omit<Parameters<typeof registry.addSubagentRunForTests>[0], "runId">,
  ) =>
    registry.addSubagentRunForTests({
      runId,
      childSessionKey,
      requesterSessionKey,
      requesterAgentId: "main",
      ...overrides,
    });
  it("delivers a yielded result despite an older failed grandchild awaiting cleanup", async () => {
    const oldTime = Date.now() - 5 * 24 * 60 * 60 * 1000;
    const oldParentKey = "agent:main:subagent:old-parent";
    await addRun("old-parent", oldParentKey, {
      childAgentId: "main",
      createdAt: oldTime,
      endedAt: oldTime + 100,
      delivery: { status: "delivered", disposition: "delivered" },
      cleanupCompletedAt: oldTime + 100,
    });
    await addRun("old-grandchild", "agent:main:subagent:old-grandchild", {
      childAgentId: "main",
      requesterSessionKey: oldParentKey,
      createdAt: oldTime + 10,
      endedAt: oldTime + 50,
      outcome: { status: "error", error: "Gateway lifecycle dispatch unavailable" },
      completion: { required: true, resultText: "unrelated old result" },
    });

    const requesterTurnRunId = "current-requester";
    const child = visibleChild("current-child");
    await spawnVisibleChild({ ...child, requesterTurnRunId });
    await settleYield(requesterTurnRunId, [child]);
    emitCompleted(child.runId, child.childSessionKey, "current counting result");
    await flushOwnedWork();
    await waitForDeliveredCleanup(child.runId);

    expect(getRequesterWakeCalls()).toHaveLength(1);
    const wakeMessage = getRequesterWakeCalls()[0]?.params?.message;
    expect(wakeMessage).toContain("current counting result");
    expect(wakeMessage).not.toContain("unrelated old result");
    expect(readRun("old-grandchild")).toMatchObject({
      delivery: { status: "pending" },
    });
    expect(readRun("old-grandchild")?.cleanupCompletedAt).toBeUndefined();
  });
  it("delivers after its owned descendant settles despite foreign active work in a global session", async () => {
    vi.setSystemTime(100_000);
    useGlobalSessionScope();
    await addRun("run-main-batch", "agent:main:subagent:batch", {
      createdAt: 1_000,
      endedAt: 1_200,
      outcome: { status: "ok" },
      expectsCompletionMessage: true,
      requesterSettleWake: {
        status: "pending",
        attemptCount: 0,
        batchRunIds: ["run-main-batch"],
        requesterYieldBatch: true,
        rearmGeneration: 1,
      },
    });
    await addRun("run-main-stale", "agent:main:subagent:stale", {
      requesterSessionKey: "agent:main:subagent:batch",
      createdAt: 2_000,
      endedAt: 2_200,
      outcome: { status: "ok" },
      expectsCompletionMessage: true,
    });
    await addRun("run-research-active", "agent:research:subagent:active", {
      requesterAgentId: "research",
      createdAt: 3_000,
    });

    const transitions: Array<{ status: string; attemptCount: number }> = [];
    const waits: Array<number | undefined> = [];
    const completions: Array<{ delivered: boolean; error?: string }> = [];
    const runWake = () =>
      maybeWakeRequesterAfterAllChildrenSettled({
        isSourceCurrent: () => true,
        requesterSessionKey,
        settledEntry: expectDefined(readRun("run-main-batch"), "main requester batch"),
        onDescendantsPending: (deadline) => waits.push(deadline),
        transitionBatch: async (entries, state, onPublished) => {
          const publication = await mutateRequesterCompletionBatch({
            entries,
            operation: { kind: "transition", state },
            assertCurrent: () => {},
            onPublished: () =>
              onPublished?.(entries.map((entry) => subagentRuns.get(entry.runId)!)),
          });
          expect(publication).toEqual({ applied: true, publication: "published" });
          transitions.push({ status: state.status, attemptCount: state.attemptCount });
        },
        completeBatch: async (entries, _rearmGeneration, outcome) => {
          const delivery = expectDefined(outcome, "requester delivery outcome");
          const publication = await mutateRequesterCompletionBatch({
            entries,
            operation: { kind: "settle", outcome: delivery },
            assertCurrent: () => {},
          });
          expect(publication).toEqual({ applied: true, publication: "published" });
          completions.push({ delivered: delivery.delivered, error: delivery.error });
        },
      });

    await expect(runWake()).resolves.toBe(false);
    expect(transitions).toEqual([]);
    expect(waits).toEqual([302_200]);
    expect(completions).toEqual([]);

    // Descendant settlement makes this recorded cohort runnable. Foreign work
    // sharing the logical key still cannot hold this physical requester's wake.
    await mutateSubagentRuns(["run-main-stale"], (rows) => {
      const stale = expectDefined(rows.get("run-main-stale"), "owned descendant");
      const settled: SubagentRunRecord = {
        ...stale,
        delivery: { status: "delivered", disposition: "delivered" },
        cleanupCompletedAt: Date.now(),
      };
      return {
        value: undefined,
        postimages: new Map([[stale.runId, settled]]),
      };
    });
    await expect(runWake()).resolves.toBe(true);
    expect(transitions).toEqual([{ status: "dispatching", attemptCount: 1 }]);
    expect(getRequesterWakeCalls()).toHaveLength(1);
    expect(completions).toEqual([{ delivered: true, error: undefined }]);
    expect(readRun("run-main-batch")?.requesterSettleWake).toBeUndefined();
    const activeDescendants = (agentId?: string) =>
      buildScopedSubagentRunReadIndexFromRuns(
        subagentRuns,
        requesterSessionKey,
        agentId,
      ).countActiveDescendantRuns(requesterSessionKey);
    expect([activeDescendants(), activeDescendants("main")]).toEqual([1, 0]);
  });

  it("wakes a yielded parent once after one running child is stopped", async () => {
    await registry.initSubagentRegistry();
    await registry.activateSubagentRegistry(createGatewayContext).settled;
    const requesterTurnRunId = "requester-stopped-pair";
    const stopped = visibleChild("stopped");
    const finished = visibleChild("finished");
    for (const child of [stopped, finished]) {
      await spawnVisibleChild({ ...child, requesterTurnRunId });
    }
    await settleYield(requesterTurnRunId, [stopped, finished]);
    const lifecycleHandler = expectDefined(getLifecycleHandler(), "lifecycle listener before Stop");
    lifecycleHandler({
      stream: "lifecycle",
      runId: stopped.runId,
      seq: 1,
      ts: Date.now(),
      sessionKey: stopped.childSessionKey,
      data: { phase: "end", endedAt: Date.now(), aborted: true, stopReason: "aborted" },
    });
    await flushOwnedWork();
    expect(getRequesterWakeCalls()).toHaveLength(0);
    expect(readRun(stopped.runId)).toMatchObject({
      endedReason: "subagent-killed",
      suppressCompletionDelivery: true,
    });

    emitCompleted(finished.runId, finished.childSessionKey, "finished sibling findings");
    await flushOwnedWork();
    expect(getRequesterWakeCalls()).toHaveLength(1);
    const wake = String(getRequesterWakeCalls()[0]?.params?.message);
    expect(wake).toContain("finished sibling findings");
    expect(wake).toMatch(
      /run-stopped\n<\/prompt-data>\nstatus: cancelled[^\n]*\n[^\n]*\n<prompt-data>\n\(no output\)/,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await registry.testing.sweepOnceForTests();
    await flushOwnedWork();
    expect(getAgentCalls()).toHaveLength(1);
    expect(readRun(finished.runId)?.requesterSettleWake).toBeUndefined();
    expect(readRun(stopped.runId)).toBeUndefined();
  });
}
