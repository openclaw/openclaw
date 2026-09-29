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
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import type { GatewayRequest } from "./subagent-registry.lifecycle-fixture.test-support.js";
import type { createLifecycleWaits } from "./subagent-registry.lifecycle-waits.test-support.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry.store.sqlite.js";
import * as registry from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

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
  const transitionPublication = createDeferred<Awaited<ReturnType<typeof mutate>>>();
  const completePublication = createDeferred<Awaited<ReturnType<typeof mutate>>>();
  let failCompletePublication = options.failCompletePublication === true;
  const mutationScope = new AsyncLocalStorage<{
    entries: readonly SubagentRunRecord[];
    phase: keyof typeof holds;
  }>();
  vi.spyOn(completionStore, "mutateRequesterSettleWakeBatch").mockImplementation((params) =>
    mutationScope.run(
      { entries: params.entries, phase: params.committed ? "reconcile" : params.operation.kind },
      async () => {
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
          if (!params.committed) {
            (params.operation.kind === "transition"
              ? transitionPublication
              : completePublication
            ).resolve(result);
          }
          return result;
        } catch (error) {
          if (!params.committed) {
            (params.operation.kind === "transition"
              ? transitionPublication
              : completePublication
            ).reject(error);
          }
          throw error;
        }
      },
    ),
  );
  const settle = vi.mocked(completionStore.settleRequesterCompletionBatch).getMockImplementation();
  if (!settle) {
    throw new Error("Requester receipt observation requires its registered settlement fixture");
  }
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
        if (phase) {
          holds[phase].entered.reject(error);
        }
        throw error;
      });
    },
  );
  const releaseAll = () => {
    holds.transition.release.resolve();
    holds.complete.release.resolve();
    holds.reconcile.release.resolve();
    holds.outcome.release.resolve();
  };
  void transitionPublication.promise.catch(() => {});
  void completePublication.promise.catch(() => {});
  for (const hold of Object.values(holds)) {
    void hold.entered.promise.catch(() => {});
  }
  return { ...holds, transitionPublication, completePublication, releaseAll };
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
    resumed: new Set([entry.runId]),
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
  expect(entry.cleanupHandled).toBe(false);
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
    rejectRequesterWake: boolean;
    rejectPersistence: boolean;
    emptyReply: boolean;
    receiptDrift?: boolean;
    outcomeDrift?: boolean;
    receiptReplacement?: "reply" | "delivery";
  }>([
    {
      name: "delivers the visible requester final",
      rejectRequesterWake: false,
      rejectPersistence: false,
      emptyReply: false,
    },
    {
      name: "reconciles a committed requester transition after same-owner cleanup drifts",
      rejectRequesterWake: false,
      rejectPersistence: false,
      emptyReply: false,
      receiptDrift: true,
    },
    {
      name: "reconciles a delivered requester outcome after same-owner cleanup drifts",
      rejectRequesterWake: false,
      rejectPersistence: false,
      emptyReply: false,
      outcomeDrift: true,
    },
    ...(["reply", "delivery"] as const).map((receiptReplacement) => ({
      name: `reconciles a replaced ${receiptReplacement} owner`,
      rejectRequesterWake: false,
      rejectPersistence: false,
      emptyReply: false,
      receiptReplacement,
    })),
    {
      name: "settles the rejected delivered-row wake",
      rejectRequesterWake: true,
      rejectPersistence: false,
      emptyReply: false,
    },
    {
      name: "backs off when rejected-wake settlement persistence fails",
      rejectRequesterWake: true,
      rejectPersistence: true,
      emptyReply: false,
    },
    {
      name: "retires a stale empty announce after requester delivery",
      rejectRequesterWake: false,
      rejectPersistence: false,
      emptyReply: true,
    },
  ])("$name", async (scenario) => {
    const {
      rejectRequesterWake,
      rejectPersistence,
      emptyReply,
      receiptDrift,
      receiptReplacement,
      outcomeDrift,
    } = scenario;
    setEmptyReply(emptyReply);
    const requesterTurnRunId = "run-requester-yield";
    const alpha = {
      runId: "run-alpha",
      childSessionKey: "agent:main:subagent:alpha",
      expectsCompletionMessage: true,
    };
    const beta = {
      runId: "run-beta",
      childSessionKey: "agent:main:subagent:beta",
      expectsCompletionMessage: true,
    };
    await spawnVisibleChild({ ...alpha, requesterTurnRunId });
    await spawnVisibleChild({ ...beta, requesterTurnRunId });
    const heldReceipts =
      !rejectRequesterWake && !emptyReply
        ? holdRequesterWakeReceipts({ holdOutcome: outcomeDrift })
        : undefined;

    holdAgentCall(beta.childSessionKey);
    emitCompleted(alpha.runId, alpha.childSessionKey, "alpha complete");
    await waitForAgentCallCount(1);
    await waitForDeliveredCleanup(alpha.runId, { allowPendingRequesterSettleWake: true });
    const modelRouteChange = "Model route changed: requested/model → actual/model.";
    emitCompleted(beta.runId, beta.childSessionKey, "beta complete", modelRouteChange);
    await waitForAgentCallCount(2);

    const betaBeforeYield = registry.getSubagentRunByRunId(beta.runId);
    if (!betaBeforeYield) {
      throw new Error("expected beta run before requester yield");
    }
    betaBeforeYield.delivery = rejectRequesterWake
      ? {
          ...betaBeforeYield.delivery,
          status: "delivered",
          disposition: "delivered",
          deliveredAt: Date.now(),
        }
      : { ...betaBeforeYield.delivery, status: "in_progress" };

    const settleWakeOwner = outcomeDrift ? observeRootWork() : undefined;
    const yieldTool = createSessionsYieldTool({
      sessionId: "sess-main",
      claimYield: async () =>
        (await registry.markRequesterTurnYielded({
          requesterSessionKey,
          requesterAgentId: "main",
          requesterTurnRunId,
        })) > 0,
      onYield: () => {},
    });
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
        expect(registry.getSubagentRunByRunId(entry.runId)).toBe(entry);
        expect(entry.requesterSettleWake).toBe(wake);
        expect(wake?.status).toBe("pending");
      }
      await registry.testing.sweepOnceForTests();
      expect(getRequesterWakeCalls()).toHaveLength(0);
      if (receiptDrift || receiptReplacement) {
        const member = members.find(({ entry }) => entry.runId === beta.runId);
        if (!member) {
          throw new Error("Missing held beta transition owner");
        }
        if (receiptReplacement === "reply") {
          const completion = member.entry.completion;
          if (!completion?.terminalReply) {
            throw new Error("Missing prepared reply owner");
          }
          completion.terminalReply = structuredClone(completion.terminalReply);
        } else if (receiptReplacement === "delivery") {
          member.entry.delivery = structuredClone(member.entry.delivery);
        } else {
          await driftCompletionCleanup(member.entry);
        }
        expect(member.entry.requesterSettleWake).toBe(member.wake);
        const database = openOpenClawStateDatabase();
        database.db.exec(
          "CREATE TRIGGER reject_wake_replay BEFORE UPDATE ON subagent_runs BEGIN SELECT RAISE(ABORT, 'requester wake write replayed'); END",
        );
        try {
          heldReceipts.transition.release.resolve();
          await expect(heldReceipts.transitionPublication.promise).resolves.toEqual({
            applied: true,
            publication: "superseded",
          });
          expect(getRequesterWakeCalls()).toHaveLength(0);
          await vi.advanceTimersByTimeAsync(30_000);
          await heldReceipts.reconcile.entered.promise;
          expect(getRequesterWakeCalls()).toHaveLength(0);
        } finally {
          database.db.exec("DROP TRIGGER reject_wake_replay");
          heldReceipts.reconcile.release.resolve();
        }
      }
      heldReceipts.transition.release.resolve();
    }
    await waitForAgentCallCount(rejectRequesterWake ? 2 : 3);
    if (outcomeDrift && heldReceipts && settleWakeOwner) {
      const members = await heldReceipts.outcome.entered.promise;
      const member = members.find(({ entry }) => entry.runId === beta.runId);
      if (!member) {
        throw new Error("Missing acknowledged requester outcome member");
      }
      expect(loadSubagentRegistryFromSqlite().get(beta.runId)?.requesterSettleWake).toBeUndefined();
      expect(member.entry.requesterSettleWake).toBe(member.wake);
      await driftCompletionCleanup(member.entry);
      const database = openOpenClawStateDatabase();
      database.db.exec(
        "CREATE TRIGGER reject_outcome_replay BEFORE UPDATE ON subagent_runs BEGIN SELECT RAISE(ABORT, 'requester outcome write replayed'); END",
      );
      try {
        heldReceipts.outcome.release.resolve();
        await settleWakeOwner(true);
        heldReceipts.reconcile.release.resolve();
        await vi.advanceTimersByTimeAsync(30_000);
        await settleWakeOwner(true);
        expect(member.entry.requesterSettleWake).toBeUndefined();
        expect(getRequesterWakeCalls()).toHaveLength(1);
      } finally {
        database.db.exec("DROP TRIGGER reject_outcome_replay");
        heldReceipts.releaseAll();
      }
    }
    await waitForDeliveredCleanup(alpha.runId, {
      allowPendingRequesterSettleWake: rejectPersistence,
    });
    expect(getRequesterWakeCalls()).toHaveLength(rejectRequesterWake ? 0 : 1);
    if (rejectPersistence) {
      expect(registry.getSubagentRunByRunId(alpha.runId)?.requesterSettleWake).toMatchObject({
        status: "pending",
        attemptCount: 0,
      });
      await vi.advanceTimersByTimeAsync(29_999);
      expect(getRequesterWakeCalls()).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
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
        expect(registry.getSubagentRunByRunId(entry.runId)).toBe(entry);
        expect(entry.requesterSettleWake).toBe(wake);
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
    expect(registry.getSubagentRunByRunId(beta.runId)?.delivery).toMatchObject({
      status: "delivered",
      disposition: "delivered",
      payload: undefined,
      lastError: undefined,
      lastDropReason: undefined,
    });
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
      if (!member) {
        throw new Error("Quiet delete wake did not retain its member");
      }
      const { entry, wake } = member;
      expect(entry.runId).toBe(runId);
      expect(wake?.retireAfterSettle).toBe(true);
      expect(loadSubagentRegistryFromSqlite().has(runId)).toBe(false);
      expect(registry.getSubagentRunByRunId(runId)).toBe(entry);
      expect(entry.requesterSettleWake).toBe(wake);
      await registry.testing.sweepOnceForTests();
      expect(getRequesterWakeCalls()).toHaveLength(0);
      const originalStateDir = process.env.OPENCLAW_STATE_DIR;
      if (!originalStateDir) {
        throw new Error("Quiet retirement requires its isolated original source");
      }
      const database = openOpenClawStateDatabase();
      let replayTrigger = false;
      try {
        if (change === "source-change") {
          process.env.OPENCLAW_STATE_DIR = statePath("replacement-state");
        }
        held.complete.release.resolve();
        if (change === "source-change") {
          await expect(held.completePublication.promise).resolves.toEqual({
            applied: true,
            publication: "superseded",
          });
          await flushOwnedWork();
          await vi.advanceTimersByTimeAsync(30_000);
          await flushOwnedWork();
          expect(registry.getSubagentRunByRunId(runId)).toBe(entry);
          expect(getGatewayContextResolver(entry)).toBeDefined();
          expect(getRequesterWakeCalls()).toHaveLength(0);
          process.env.OPENCLAW_STATE_DIR = originalStateDir;
        } else if (change === "callback-failure") {
          await expect(held.completePublication.promise).rejects.toMatchObject({
            outcome: "committed",
            publication: "published",
          });
          await flushOwnedWork();
          expect(registry.getSubagentRunByRunId(runId)).toBeUndefined();
          expect(getGatewayContextResolver(entry)).toBeDefined();
        }
        if (change !== "unchanged") {
          database.db.exec(
            "CREATE TRIGGER reject_quiet_retirement_replay BEFORE DELETE ON subagent_runs BEGIN SELECT RAISE(ABORT, 'quiet retirement replayed'); END",
          );
          replayTrigger = true;
          await registry.testing.sweepOnceForTests();
          await vi.advanceTimersByTimeAsync(30_000);
          await held.reconcile.entered.promise;
          database.db.exec("DROP TRIGGER reject_quiet_retirement_replay");
          replayTrigger = false;
          held.reconcile.release.resolve();
        }
        await flushOwnedWork();
        expect(registry.getSubagentRunByRunId(runId)).toBeUndefined();
        expect(loadSubagentRegistryFromSqlite().has(runId)).toBe(false);
        expect(getGatewayContextResolver(entry)).toBeUndefined();
        expect(getRequesterWakeCalls()).toHaveLength(0);
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
