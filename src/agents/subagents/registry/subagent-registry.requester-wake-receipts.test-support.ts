import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { getGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import { createSubagentRunParams } from "../../subagent-test-fixtures.test-helpers.js";
import { createSessionsYieldTool } from "../../tools/sessions-yield-tool.js";
import * as completionStore from "../completion/subagent-completion-admission.store.js";
import { createSubagentRegistryCompletionRuntime } from "./subagent-registry-completion-runtime.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  mutateSubagentRuns,
  SubagentRegistryVersionConflictError,
} from "./subagent-registry-persistence.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import type { GatewayRequest } from "./subagent-registry.lifecycle-fixture.test-support.js";
import type { createLifecycleWaits } from "./subagent-registry.lifecycle-waits.test-support.js";
import * as registry from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { getSubagentRunRuntimeKey, isSameSubagentRunOwner } from "./subagent-run-generation.js";

export function createRequesterYieldTool(requesterSessionKey: string, requesterTurnRunId: string) {
  return createSessionsYieldTool({
    sessionId: "sess-main",
    claimYield: async () =>
      (await registry.markRequesterTurnYielded({
        requesterSessionKey,
        requesterAgentId: "main",
        requesterTurnRunId,
      })) > 0,
    onYield: () => {},
  });
}

export function visibleChild(name: string) {
  return {
    runId: `run-${name}`,
    childSessionKey: `agent:main:subagent:${name}`,
    expectsCompletionMessage: true,
  };
}

function createRequesterWakeReceiptHolds(
  options: { failCompletePublication?: boolean; holdOutcome?: boolean } = {},
) {
  type CapturedMember = {
    entry: SubagentRunRecord;
    wake: SubagentRunRecord["requesterSettleWake"];
  };
  const holds = {
    transition: { entered: createDeferred<CapturedMember[]>(), release: createDeferred() },
    complete: { entered: createDeferred<CapturedMember[]>(), release: createDeferred() },
    outcome: { entered: createDeferred<CapturedMember[]>(), release: createDeferred() },
    reconcile: { entered: createDeferred<CapturedMember[]>(), release: createDeferred() },
  };
  const mutate = completionStore.mutateRequesterSettleWakeBatch;
  const publications = {
    transition: createDeferred<Awaited<ReturnType<typeof mutate>>>(),
    complete: createDeferred<Awaited<ReturnType<typeof mutate>>>(),
    reconcile: createDeferred<Awaited<ReturnType<typeof mutate>>>(),
  };
  let failCompletePublication = options.failCompletePublication === true;
  const mutationScope = new AsyncLocalStorage<{
    entries: readonly SubagentRunRecord[];
    phase: keyof typeof holds;
  }>();
  vi.spyOn(completionStore, "mutateRequesterSettleWakeBatch").mockImplementation((params) =>
    mutationScope.run(
      { entries: params.entries, phase: params.committed ? "reconcile" : params.operation.kind },
      async () => {
        const publication = publications[params.committed ? "reconcile" : params.operation.kind];
        try {
          const result = await mutate({
            ...params,
            onPublished() {
              params.onPublished();
              if (params.operation.kind === "complete" && failCompletePublication) {
                failCompletePublication = false;
                throw new Error("Synthetic published retirement callback failure");
              }
            },
          });
          publication.resolve(result);
          return result;
        } catch (error) {
          publication.reject(error);
          throw error;
        }
      },
    ),
  );
  const settle = vi.mocked(completionStore.settleRequesterCompletionBatch).getMockImplementation();
  assert(settle, "Requester receipt observation requires its registered settlement fixture");
  vi.spyOn(completionStore, "settleRequesterCompletionBatch").mockImplementation((params) =>
    mutationScope.run(
      {
        entries: params.entries.map(({ subagent }) => subagent),
        phase: params.committed ? "reconcile" : "outcome",
      },
      () => settle(params),
    ),
  );
  if (!options.holdOutcome) {
    holds.outcome.release.resolve();
  }
  const observed = new Set<keyof typeof holds>();
  const executions: Array<keyof typeof holds> = [];
  const runWorker = stateWorker.runOpenClawStateWorkerOperation;
  vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockImplementation(
    (context, operation, workerOptions) => {
      // The worker owner restores its admitted async context after this boundary.
      const capturedMutation = mutationScope.getStore();
      return runWorker(
        context,
        (scope) =>
          operation({
            execute: async (command, executeOptions) => {
              const mutation =
                command.type === "sessionDelivery.mutateSubagentCompletion"
                  ? capturedMutation
                  : undefined;
              const phase = mutation?.phase;
              const hold = phase && !observed.has(phase) ? holds[phase] : undefined;
              const members =
                hold && mutation
                  ? mutation.entries.map((entry) => ({ entry, wake: entry.requesterSettleWake }))
                  : [];
              const result = await scope.execute(command, executeOptions);
              if (phase) {
                executions.push(phase);
              }
              if (typeof result === "object" && result !== null && "conflictRunIds" in result) {
                return result;
              }
              if (hold && phase) {
                observed.add(phase);
                hold.entered.resolve(members);
                await hold.release.promise;
              }
              return result;
            },
          }),
        workerOptions,
      ).catch((error: unknown) => {
        const phase = capturedMutation?.phase;
        if (phase && !(error instanceof SubagentRegistryVersionConflictError)) {
          holds[phase].entered.reject(error);
        }
        throw error;
      });
    },
  );
  const releaseAll = () => {
    for (const hold of Object.values(holds)) {
      hold.release.resolve();
    }
  };
  for (const publication of Object.values(publications)) {
    void publication.promise.catch(() => {});
  }
  for (const hold of Object.values(holds)) {
    void hold.entered.promise.catch(() => {});
  }
  return {
    ...holds,
    publications,
    executions,
    releaseAll,
  };
}

async function driftCompletionCleanup(entry: SubagentRunRecord): Promise<void> {
  expect(entry.cleanupHandled).toBe(true);
  expect(entry.cleanupCompletedAt).toBeUndefined();
  const failed = vi.fn(async () => {
    throw new Error("Synthetic terminal completion refusal");
  });
  const resume = vi.fn();
  const recovery = createSubagentRegistryCompletionRuntime({
    runs: subagentRuns,
    resumed: new Set([getSubagentRunRuntimeKey(entry)]),
    retryTimers: new Set(),
    completeSubagentRun: failed,
    scheduleSweep: vi.fn(),
    resumeRun: resume,
    warn: vi.fn(),
  });
  await recovery.completeSubagentRunWithRecovery(
    {
      runId: entry.runId,
      expectedEntry: entry,
      outcome: { status: "ok" },
      reason: "subagent-complete",
      triggerCleanup: true,
    },
    "requester-wake-ack-proof",
  );
  expect(failed).toHaveBeenCalledTimes(2);
  expect(resume).toHaveBeenCalledWith(entry.runId);
  expect(subagentRuns.get(entry.runId)?.cleanupHandled).toBe(false);
}

export function registerRequesterWakeReceiptBoundaryTests({
  requesterSessionKey,
  spawnVisibleChild,
  emitCompleted,
  flushOwnedWork,
  waitForDeliveredCleanup,
  waitForAgentCallCount,
  getRequesterWakeCalls,
  createGatewayContext,
  statePath,
  sendMessageMock,
  setEmptyReply,
  setWakeRefusal,
  holdAgentCall,
  releaseAgentCall,
  onReceiptsHeld,
}: {
  requesterSessionKey: string;
  spawnVisibleChild: (params: {
    runId: string;
    childSessionKey: string;
    requesterTurnRunId: string;
    expectsCompletionMessage: boolean;
  }) => Promise<void>;
  emitCompleted: (
    runId: string,
    childSessionKey: string,
    text: string,
    modelRouteChange?: string,
  ) => void;
  flushOwnedWork: () => Promise<void>;
  waitForDeliveredCleanup: ReturnType<typeof createLifecycleWaits>["waitForDeliveredCleanup"];
  waitForAgentCallCount: (count: number) => Promise<void>;
  getRequesterWakeCalls: () => GatewayRequest[];
  createGatewayContext: () => GatewayRequestContext;
  statePath: (...parts: string[]) => string;
  sendMessageMock: typeof import("../../../infra/outbound/message.js").sendMessage;
  setEmptyReply: (value: boolean) => void;
  setWakeRefusal: (wake: boolean, persistence: boolean) => void;
  holdAgentCall: (sessionKey: string) => void;
  releaseAgentCall: (sessionKey: string) => void;
  onReceiptsHeld: (release: () => void) => void;
}): void {
  const holdRequesterWakeReceipts = (
    options?: Parameters<typeof createRequesterWakeReceiptHolds>[0],
  ) => {
    const holds = createRequesterWakeReceiptHolds(options);
    onReceiptsHeld(holds.releaseAll);
    return holds;
  };
  it.each<{
    name: string;
    rejectRequesterWake?: boolean;
    rejectPersistence?: boolean;
    emptyReply?: boolean;
    receiptDrift?: boolean;
    outcomeDrift?: boolean;
    receiptReplacement?: "reply" | "delivery";
  }>([
    {
      name: "delivers the visible requester final",
    },
    {
      name: "publishes a requester transition before queued same-owner cleanup",
      receiptDrift: true,
    },
    {
      name: "publishes a delivered requester outcome before queued same-owner cleanup",
      outcomeDrift: true,
    },
    ...(["reply", "delivery"] as const).map((receiptReplacement) => ({
      name: `preserves a requester receipt across queued equivalent ${receiptReplacement} metadata`,
      receiptReplacement,
    })),
    {
      name: "settles the rejected delivered-row wake",
      rejectRequesterWake: true,
    },
    {
      name: "backs off when rejected-wake settlement persistence fails",
      rejectRequesterWake: true,
      rejectPersistence: true,
    },
    {
      name: "retires a stale empty announce after requester delivery",
      emptyReply: true,
    },
  ])("$name", async (scenario) => {
    const {
      rejectRequesterWake = false,
      rejectPersistence = false,
      emptyReply = false,
      receiptDrift,
      receiptReplacement,
      outcomeDrift,
    } = scenario;
    setEmptyReply(emptyReply);
    const requesterTurnRunId = "run-requester-yield";
    const alpha = visibleChild("alpha");
    const beta = visibleChild("beta");
    await spawnVisibleChild({ ...alpha, requesterTurnRunId });
    await spawnVisibleChild({ ...beta, requesterTurnRunId });
    const heldReceipts =
      !rejectRequesterWake && !emptyReply
        ? holdRequesterWakeReceipts({ holdOutcome: outcomeDrift })
        : undefined;

    holdAgentCall(beta.childSessionKey);
    emitCompleted(alpha.runId, alpha.childSessionKey, "alpha complete");
    await waitForAgentCallCount(1);
    const beforeCleanup = Date.now();
    await waitForDeliveredCleanup(alpha.runId, { allowPendingRequesterSettleWake: true });
    expect(Date.now(), "cleanup observation must not spend the retry clock").toBe(beforeCleanup);
    const modelRouteChange = "Model route changed: requested/model → actual/model.";
    emitCompleted(beta.runId, beta.childSessionKey, "beta complete", modelRouteChange);
    await waitForAgentCallCount(2);

    const betaBeforeYield = registry.getSubagentRunByRunId(beta.runId);
    assert(betaBeforeYield, "expected beta run before requester yield");
    await mutateSubagentRuns([beta.runId], (rows) => {
      const current = rows.get(beta.runId);
      assert(current && isSameSubagentRunOwner(current, betaBeforeYield));
      const next = structuredClone(current);
      next.delivery = rejectRequesterWake
        ? {
            ...next.delivery,
            status: "delivered",
            disposition: "delivered",
            deliveredAt: Date.now(),
          }
        : { ...next.delivery, status: "in_progress" };
      return { value: undefined, postimages: new Map([[next.runId, next]]) };
    });

    const settleWakeOwner = outcomeDrift || rejectPersistence ? observeRootWork() : undefined;
    const yieldTool = createRequesterYieldTool(requesterSessionKey, requesterTurnRunId);
    await expect(
      yieldTool.execute("yield-requester-wake", { message: "Wait for visible children" }),
    ).resolves.toMatchObject({ details: { status: "yielded" } });

    setWakeRefusal(rejectRequesterWake, rejectPersistence);
    const { withLocalSessionPlacementTurnSettlement } =
      await import("../../session-placement-admission.js");
    await withLocalSessionPlacementTurnSettlement(
      {
        sessionId: "sess-main",
        sessionKey: requesterSessionKey,
        agentId: "main",
        runId: requesterTurnRunId,
      },
      async () => ({
        acceptedSessionSpawns: [alpha, beta],
        meta: {
          durationMs: 1,
          yielded: true,
          executionTrace: { runner: "cli", attempts: [], fallbackUsed: false },
        },
      }),
    );
    if (heldReceipts) {
      const members = await heldReceipts.transition.entered.promise;
      expect(members).toHaveLength(2);
      for (const { entry, wake } of members) {
        const current = registry.getSubagentRunByRunId(entry.runId);
        expect(isSameSubagentRunOwner(current, entry)).toBe(true);
        expect(current?.requesterSettleWake).toEqual(wake);
        expect(wake?.status).toBe("pending");
      }
      await registry.testing.sweepOnceForTests();
      expect(getRequesterWakeCalls()).toHaveLength(0);
      if (receiptDrift || receiptReplacement) {
        const member = members.find(({ entry }) => entry.runId === beta.runId);
        assert(member, "Missing held beta transition owner");
        const planSuccessor = vi.fn((rows: ReadonlyMap<string, SubagentRunRecord>) => {
          const current = rows.get(beta.runId);
          assert(current && isSameSubagentRunOwner(current, member.entry));
          expect(current.requesterSettleWake?.status).toBe("dispatching");
          const next = structuredClone(current);
          if (receiptReplacement === "reply") {
            const reply = next.completion?.terminalReply;
            assert(reply && next.completion, "Missing prepared reply owner");
            next.completion.terminalReply = structuredClone(reply);
          } else {
            next.delivery = structuredClone(next.delivery);
          }
          return { value: undefined, postimages: new Map([[next.runId, next]]) };
        });
        const successor = receiptDrift
          ? driftCompletionCleanup(member.entry)
          : mutateSubagentRuns([beta.runId], planSuccessor);
        void successor.catch(() => {});
        expect(planSuccessor).not.toHaveBeenCalled();
        expect(registry.getSubagentRunByRunId(beta.runId)?.requesterSettleWake).toEqual(
          member.wake,
        );
        const database = openOpenClawStateDatabase();
        // Beta's queued metadata write and the later settled outcome remain allowed.
        // The isolated test database owns trigger cleanup after its workers drain.
        database.db.exec(
          "CREATE TRIGGER reject_wake_replay BEFORE UPDATE ON subagent_runs WHEN NEW.run_id = 'run-alpha' AND json_extract(NEW.payload_json, '$.requesterSettleWake.status') = 'dispatching' BEGIN SELECT RAISE(ABORT, 'requester wake write replayed'); END",
        );
        try {
          heldReceipts.transition.release.resolve();
          await expect(heldReceipts.publications.transition.promise).resolves.toEqual({
            applied: true,
            publication: "published",
          });
          await successor;
          if (receiptReplacement) {
            expect(planSuccessor).toHaveBeenCalledOnce();
          }
          expect(heldReceipts.executions.filter((phase) => phase === "transition")).toHaveLength(1);
          expect(heldReceipts.executions).not.toContain("reconcile");
        } finally {
          heldReceipts.transition.release.resolve();
          await Promise.allSettled([successor]);
        }
      }
      heldReceipts.transition.release.resolve();
    }
    await waitForAgentCallCount(rejectRequesterWake ? 2 : 3);
    if (outcomeDrift && heldReceipts && settleWakeOwner) {
      const members = await heldReceipts.outcome.entered.promise;
      const member = members.find(({ entry }) => entry.runId === beta.runId);
      assert(member, "Missing acknowledged requester outcome member");
      expect(loadSubagentRegistryFromSqlite().get(beta.runId)?.requesterSettleWake).toBeUndefined();
      expect(registry.getSubagentRunByRunId(beta.runId)?.requesterSettleWake).toEqual(member.wake);
      const successor = driftCompletionCleanup(member.entry);
      void successor.catch(() => {});
      const database = openOpenClawStateDatabase();
      // Guard the committed outcome through cleanup; database teardown removes the trigger.
      database.db.exec(
        "CREATE TRIGGER reject_outcome_replay BEFORE UPDATE ON subagent_runs WHEN NEW.run_id = 'run-alpha' BEGIN SELECT RAISE(ABORT, 'requester outcome write replayed'); END",
      );
      try {
        heldReceipts.outcome.release.resolve();
        await successor;
        await settleWakeOwner(true);
        expect(registry.getSubagentRunByRunId(beta.runId)?.requesterSettleWake).toBeUndefined();
        expect(getRequesterWakeCalls()).toHaveLength(1);
        expect(heldReceipts.executions.filter((phase) => phase === "outcome")).toHaveLength(1);
        expect(heldReceipts.executions).not.toContain("reconcile");
      } finally {
        heldReceipts.releaseAll();
        await Promise.allSettled([successor]);
      }
    }
    await waitForDeliveredCleanup(alpha.runId, {
      allowPendingRequesterSettleWake: rejectPersistence,
    });
    expect(getRequesterWakeCalls()).toHaveLength(rejectRequesterWake ? 0 : 1);
    if (rejectPersistence) {
      // Alpha was already delivered before yield. Join the rejected wake owner
      // before measuring its backoff; delivered cleanup does not imply it settled.
      await settleWakeOwner?.(true);
      expect(registry.getSubagentRunByRunId(alpha.runId)?.requesterSettleWake).toMatchObject({
        status: "pending",
        attemptCount: 0,
      });
      await vi.advanceTimersByTimeAsync(29_999);
      await settleWakeOwner?.(true);
      expect(registry.getSubagentRunByRunId(alpha.runId)?.requesterSettleWake).toMatchObject({
        status: "pending",
        attemptCount: 0,
      });
      expect(getRequesterWakeCalls()).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      await settleWakeOwner?.(true);
      await waitForDeliveredCleanup(alpha.runId);
      expect(getRequesterWakeCalls()).toHaveLength(0);
    }
    if (!rejectRequesterWake) {
      const wakeMessage = getRequesterWakeCalls()[0]?.params?.message;
      expect(wakeMessage).toContain(modelRouteChange);
      // Yielded batches must retain the same outcome/blocked boundary as
      // individual completions, not downgrade failed checks to a final update.
      expect(wakeMessage).toContain(
        "Reviews, failed checks, and other in-scope fixable blockers require continued work",
      );
      expect(wakeMessage).toContain(
        "report a blocker only when progress needs new user authority or an unavailable external decision",
      );
      expect(wakeMessage).toContain(
        "Keep this runtime-authored model-route change notice internal on this shared surface.",
      );
    }
    for (const child of [alpha, beta]) {
      const entry = registry.getSubagentRunByRunId(child.runId);
      expect(entry).toMatchObject({
        delivery: { status: "delivered" },
      });
      expect(entry?.requesterSettleWake).toBeUndefined();
    }

    releaseAgentCall(beta.childSessionKey);
    if (receiptDrift || outcomeDrift) {
      heldReceipts?.releaseAll();
      // The failed completion owner revoked this older child cleanup attempt.
      // Join its refusal; requester recovery must not require it to mint another wake.
      await flushOwnedWork();
      await registry.testing.sweepOnceForTests();
      await vi.advanceTimersByTimeAsync(30_000);
      await flushOwnedWork();
      const stored = loadSubagentRegistryFromSqlite();
      for (const child of [alpha, beta]) {
        expect(stored.get(child.runId)?.delivery?.status).toBe("delivered");
        expect(stored.get(child.runId)?.requesterSettleWake).toBeUndefined();
      }
      expect(getRequesterWakeCalls()).toHaveLength(1);
      expect(sendMessageMock).not.toHaveBeenCalled();
      return;
    }
    if (heldReceipts) {
      const members = await heldReceipts.complete.entered.promise;
      expect(members.length).toBeGreaterThan(0);
      for (const { entry, wake } of members) {
        const current = registry.getSubagentRunByRunId(entry.runId);
        expect(isSameSubagentRunOwner(current, entry)).toBe(true);
        expect(current?.requesterSettleWake).toEqual(wake);
        expect(wake).toBeDefined();
      }
      await registry.testing.sweepOnceForTests();
      expect(getRequesterWakeCalls()).toHaveLength(1);
      heldReceipts.complete.release.resolve();
    }
    await waitForDeliveredCleanup(alpha.runId);
    await waitForDeliveredCleanup(beta.runId);
    await registry.testing.sweepOnceForTests();
    expect(getRequesterWakeCalls()).toHaveLength(rejectRequesterWake ? 0 : 1);
    expect(sendMessageMock).not.toHaveBeenCalled();
    const delivery = registry.getSubagentRunByRunId(beta.runId)?.delivery;
    expect(delivery).toMatchObject({
      status: "delivered",
      disposition: "delivered",
    });
    expect(delivery?.payload).toBeUndefined();
    expect(delivery?.lastError).toBeUndefined();
    expect(delivery?.lastDropReason).toBeUndefined();
  });

  it.each(["unchanged", "source-change", "callback-failure"] as const)(
    "keeps quiet retirement custody (%s)",
    async (change) => {
      const runId = "quiet-delete-wake";
      const childSessionKey = "agent:main:subagent:quiet-delete-wake";
      const gateway = createGatewayContext();
      await registry.registerSubagentRun(
        createSubagentRunParams({
          runId,
          childSessionKey,
          requesterAgentId: "main",
          cleanup: "delete",
          expectsCompletionMessage: false,
          gatewayContextResolver: () => gateway,
        }),
      );
      const held = holdRequesterWakeReceipts({
        failCompletePublication: change === "callback-failure",
      });
      emitCompleted(runId, childSessionKey, "Quiet child complete");
      const members = await held.complete.entered.promise;
      expect(members).toHaveLength(1);
      const member = members[0];
      assert(member, "Quiet delete wake did not retain its member");
      const { entry, wake } = member;
      expect(entry.runId).toBe(runId);
      expect(wake?.retireAfterSettle).toBe(true);
      expect(loadSubagentRegistryFromSqlite().has(runId)).toBe(false);
      expect(isSameSubagentRunOwner(registry.getSubagentRunByRunId(runId), entry)).toBe(true);
      expect(registry.getSubagentRunByRunId(runId)?.requesterSettleWake).toEqual(wake);
      await registry.testing.sweepOnceForTests();
      expect(getRequesterWakeCalls()).toHaveLength(0);
      const originalStateDir = process.env.OPENCLAW_STATE_DIR;
      assert(originalStateDir, "Quiet retirement requires its isolated original source");
      const database = openOpenClawStateDatabase();
      let replayTrigger = false;
      try {
        if (change === "source-change") {
          process.env.OPENCLAW_STATE_DIR = statePath("replacement-state");
        }
        held.complete.release.resolve();
        if (change === "source-change") {
          await expect(held.publications.complete.promise).rejects.toMatchObject({
            outcome: "committed",
            publication: "superseded",
          });
          await flushOwnedWork();
          await vi.advanceTimersByTimeAsync(30_000);
          await flushOwnedWork();
          expect(isSameSubagentRunOwner(registry.getSubagentRunByRunId(runId), entry)).toBe(true);
          expect(getGatewayContextResolver(entry)).toBeDefined();
          expect(getRequesterWakeCalls()).toHaveLength(0);
          process.env.OPENCLAW_STATE_DIR = originalStateDir;
        } else if (change === "callback-failure") {
          await expect(held.publications.complete.promise).rejects.toMatchObject({
            outcome: "committed",
            publication: "published",
          });
          await flushOwnedWork();
          expect(registry.getSubagentRunByRunId(runId)).toBeUndefined();
          expect(getGatewayContextResolver(entry)).toBeDefined();
        } else {
          await expect(held.publications.complete.promise).resolves.toEqual({
            applied: true,
            publication: "published",
          });
        }
        if (change !== "unchanged") {
          database.db.exec(
            "CREATE TRIGGER reject_quiet_retirement_replay BEFORE DELETE ON subagent_runs BEGIN SELECT RAISE(ABORT, 'quiet retirement replayed'); END",
          );
          replayTrigger = true;
          await registry.testing.sweepOnceForTests();
          await vi.advanceTimersByTimeAsync(30_000);
          await held.reconcile.entered.promise;
          held.reconcile.release.resolve();
          await expect(held.publications.reconcile.promise).resolves.toEqual({
            applied: true,
            publication: "published",
          });
          database.db.exec("DROP TRIGGER reject_quiet_retirement_replay");
          replayTrigger = false;
        }
        await flushOwnedWork();
        expect(registry.getSubagentRunByRunId(runId)).toBeUndefined();
        expect(loadSubagentRegistryFromSqlite().has(runId)).toBe(false);
        expect(getGatewayContextResolver(entry)).toBeUndefined();
        expect(getRequesterWakeCalls()).toHaveLength(0);
        expect(held.executions.filter((phase) => phase === "complete")).toHaveLength(1);
        // A source change first refreshes its committed deletion after a version conflict.
        expect(held.executions.filter((phase) => phase === "reconcile")).toHaveLength(
          change === "unchanged" ? 0 : change === "source-change" ? 2 : 1,
        );
      } finally {
        process.env.OPENCLAW_STATE_DIR = originalStateDir;
        if (replayTrigger) {
          database.db.exec("DROP TRIGGER reject_quiet_retirement_replay");
        }
        held.releaseAll();
      }
    },
  );
}
