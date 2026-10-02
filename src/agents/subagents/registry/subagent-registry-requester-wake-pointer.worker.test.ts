import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../shared/deferred.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { mutateRequesterSettleWakeBatch } from "../completion/subagent-completion-admission.store.js";
import type { SubagentLifecycleWakeContext } from "./subagent-registry-lifecycle-context.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import {
  commitRequesterWake,
  getPendingWakeCommit,
  retryPendingWakeCommit,
} from "./subagent-registry-requester-wake-commit.js";
import { withSubagentRunReadSnapshot } from "./subagent-registry-state.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry.store.sqlite.js";

vi.mock("./subagent-registry-lifecycle-delivery.js", () => ({
  maskLifecycleIdentifier: () => "synthetic",
}));

it("publishes a selected requester wake before an overlapping row mutation plans", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const entry = createSubagentRunRecord({
      runId: "selected-wake",
      childSessionKey: "agent:main:subagent:selected-wake",
      requesterSessionKey: "agent:main:requester",
      endedAt: 2,
      outcome: { status: "ok" },
      completion: { required: true, resultText: "Retained result" },
      delivery: { status: "pending" },
      requesterSettleWake: { status: "pending", attemptCount: 0, rearmGeneration: 1 },
    });
    const context = captureOpenClawStateWorkerContext();
    await mutateSubagentRuns(
      [entry.runId],
      () => ({ value: undefined, postimages: new Map([[entry.runId, entry]]) }),
      { context },
    );
    const selected = await withSubagentRunReadSnapshot(
      subagentRuns,
      (snapshot) => ({ runIds: [...snapshot.keys()], sessionKeys: [] }),
      (_selection, runs) => runs.get(entry.runId),
      { runIds: new Set([entry.runId]) },
    );
    if (!selected) {
      throw new Error("Selected requester wake is unavailable");
    }
    const wakeReached = createDeferredCore();
    const releaseWake = createDeferredCore();
    const ackReached = createDeferredCore();
    const releaseAck = createDeferredCore();
    const execute = stateWorker.runOpenClawStateWorkerOperation;
    const held = vi
      .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
      .mockImplementation((owner, run, options) =>
        execute(
          owner,
          (scope) =>
            run({
              execute: async (command, executeOptions) => {
                if (command.type === "sessionDelivery.mutateSubagentCompletion") {
                  wakeReached.resolve();
                  await releaseWake.promise;
                }
                const receipt = await scope.execute(command, executeOptions);
                if (command.type === "subagents.persistChanges") {
                  ackReached.resolve();
                  await releaseAck.promise;
                }
                return receipt;
              },
            }),
          options,
        ),
      );
    const wake = mutateRequesterSettleWakeBatch({
      entries: [selected],
      operation: {
        kind: "transition",
        state: { status: "dispatching", attemptCount: 1, rearmGeneration: 1 },
      },
      context,
      assertCurrent: () => {},
      onCommitted: () => {},
      onPublished: () => {},
    });
    const wakeResult = wake.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    let successor: Promise<void> | undefined;
    const successorPlanned = vi.fn();
    try {
      await Promise.race([wakeReached.promise, wake]);
      successor = mutateSubagentRuns(
        [entry.runId],
        (rows) => {
          successorPlanned();
          const current = rows.get(entry.runId)!;
          expect(current.requesterSettleWake?.status).toBe("dispatching");
          const next = { ...structuredClone(current), cleanupHandled: true };
          return { value: undefined, postimages: new Map([[next.runId, next]]) };
        },
        { context },
      );
      expect(successorPlanned).not.toHaveBeenCalled();
      releaseWake.resolve();
      expect(await wakeResult).toEqual({ value: { applied: true, publication: "published" } });
      await Promise.race([ackReached.promise, successor]);
      expect(subagentRuns.get(entry.runId)?.requesterSettleWake?.status).toBe("dispatching");
      expect(selected.requesterSettleWake?.status).toBe("pending");
      releaseAck.resolve();
      await successor;
      expect(successorPlanned).toHaveBeenCalledOnce();
      expect(subagentRuns.get(entry.runId)?.cleanupHandled).toBe(true);
      expect(loadSubagentRegistryFromSqlite().get(entry.runId)?.requesterSettleWake?.status).toBe(
        "dispatching",
      );
    } finally {
      releaseWake.resolve();
      releaseAck.resolve();
      await Promise.allSettled([wake, successor]);
      held.mockRestore();
      subagentRuns.delete(entry.runId);
    }
  });
});

it("keeps a known requester wake commit across an immutable row publication", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const entry = createSubagentRunRecord({
      runId: "snapshot-wake",
      childSessionKey: "agent:main:subagent:snapshot-wake",
      requesterSessionKey: "agent:main:requester",
      createdAt: Date.now() - 20,
      endedAt: Date.now() - 10,
      outcome: { status: "ok" },
      completion: { required: true, resultText: "Retained result" },
      delivery: { status: "pending" },
      requesterSettleWake: { status: "dispatching", attemptCount: 3, rearmGeneration: 1 },
    });
    await mutateSubagentRuns([entry.runId], () => ({
      value: undefined,
      postimages: new Map([[entry.runId, entry]]),
    }));
    const unexpected = (): never => {
      throw new Error("Unexpected lifecycle side effect");
    };
    const context: SubagentLifecycleWakeContext = {
      options: {
        runs: subagentRuns,
        resumedRuns: new Set(),
        subagentAnnounceTimeoutMs: 1_000,
        getRuntimeConfig: () => ({}),
        clearPendingLifecycleError: unexpected,
        countPendingDescendantRuns: async () => 0,
        getLatestRunForChildSession: () => null,
        suppressAnnounceForSteerRestart: () => false,
        shouldEmitEndedHookForRun: () => false,
        emitSubagentEndedHookForRun: unexpected,
        emitSubagentProgressEndedForRun: unexpected,
        notifyContextEngineSubagentEnded: unexpected,
        retireSupersededRun: unexpected,
        resumeSubagentRun: unexpected,
        callGateway: unexpected,
        captureSubagentCompletionReply: unexpected,
        runSubagentAnnounceFlow: unexpected,
        maybeWakeRequesterAfterAllChildrenSettled: unexpected,
        warn: vi.fn(),
      },
      scheduledRequesterSettleWakeTimers: new Map(),
      scheduledRequesterSettleWakeRuns: new Set(),
      pendingRequesterSettleWakeRearms: new Set(),
      cancelledRequesterSettleWakeRuns: new Set(),
      pendingRequesterSettleWakeCommits: new Map(),
      newerGenerationOwnsSession: () => false,
      shouldSuppressSessionEffects: async () => false,
      sessionEffectsHostCurrent: () => true,
      getSessionEffects: () => undefined,
      resumeAncestorCleanup: unexpected,
      runRequesterSettleWake: unexpected,
      unmarkRequesterSettleWakeRunScheduled: unexpected,
    };
    const releaseWake = createDeferredCore();
    const wakeStarted = createDeferredCore();
    const commit = vi.fn<() => Promise<boolean>>(async () => {
      if (commit.mock.calls.length === 1) {
        wakeStarted.resolve();
        await releaseWake.promise;
        return false;
      }
      return true;
    });
    const pendingWake = commitRequesterWake(context, [entry], 1, commit, true);
    await Promise.race([
      wakeStarted.promise,
      pendingWake.then(() => {
        throw new Error("Wake commit returned before entering its persistence operation");
      }),
    ]);
    const original = getPendingWakeCommit(context, entry);
    expect(original).toBeDefined();
    if (!original) {
      throw new Error("Missing original requester wake operation");
    }
    const ackReached = createDeferredCore();
    const releaseAck = createDeferredCore();
    const execute = stateWorker.runOpenClawStateWorkerOperation;
    const held = vi
      .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
      .mockImplementation((owner, run, options) =>
        execute(
          owner,
          (scope) =>
            run({
              execute: async (command, executeOptions) => {
                const receipt = await scope.execute(command, executeOptions);
                if (command.type === "subagents.persistChanges") {
                  ackReached.resolve();
                  await releaseAck.promise;
                }
                return receipt;
              },
            }),
          options,
        ),
      );
    const owner = captureOpenClawStateWorkerContext();
    const publication = mutateSubagentRuns(
      [entry.runId],
      (rows) => {
        const next = { ...structuredClone(rows.get(entry.runId)!), cleanupHandled: true };
        return { value: undefined, postimages: new Map([[next.runId, next]]) };
      },
      { context: owner },
    );
    const joinedPublication = publication.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      await Promise.race([
        ackReached.promise,
        joinedPublication.then((result) => {
          if ("error" in result) {
            throw result.error;
          }
          throw new Error("Native publication returned without reaching the held acknowledgement");
        }),
      ]);
      expect(getPendingWakeCommit(context, entry)).toBe(original);
      releaseAck.resolve();
      await publication;
      expect(subagentRuns.get(entry.runId)?.cleanupHandled).toBe(true);
      expect(getPendingWakeCommit(context, entry)).toBe(original);
      releaseWake.resolve();
      await pendingWake;
      expect(getPendingWakeCommit(context, entry)).toBe(original);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(original.nextAttemptAt);
      await retryPendingWakeCommit(context, original);
      expect(commit).toHaveBeenCalledTimes(2);
      expect(getPendingWakeCommit(context, entry)).toBeUndefined();
    } finally {
      releaseAck.resolve();
      releaseWake.resolve();
      await Promise.all([joinedPublication, pendingWake]);
      held.mockRestore();
      vi.useRealTimers();
      subagentRuns.delete(entry.runId);
    }
  });
});
