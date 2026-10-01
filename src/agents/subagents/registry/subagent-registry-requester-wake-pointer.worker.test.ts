import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../shared/deferred.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { mutateRequesterSettleWakeBatch } from "../completion/subagent-completion-admission.store.js";
import type { SubagentLifecycleWakeContext } from "./subagent-registry-lifecycle-context.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  captureSubagentRunMutationSnapshot,
  publishSubagentRunPostimages,
} from "./subagent-registry-persistence.js";
import {
  commitRequesterWake,
  getPendingWakeCommit,
  retryPendingWakeCommit,
} from "./subagent-registry-requester-wake-commit.js";
import {
  persistSubagentRunsToDiskAsyncOrThrow,
  withSubagentRunReadSnapshot,
} from "./subagent-registry-state.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry.store.sqlite.js";

vi.mock("./subagent-registry-lifecycle-delivery.js", () => ({
  maskLifecycleIdentifier: () => "synthetic",
}));

it("publishes a selected requester wake across unchanged staging without accepting an older acknowledgement", async () => {
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
    subagentRuns.set(entry.runId, entry);
    const context = captureOpenClawStateWorkerContext();
    await persistSubagentRunsToDiskAsyncOrThrow(subagentRuns, [entry.runId], { context });
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
      retiredPreimages: new Set(),
    });
    const wakeResult = wake.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    let staging: ReturnType<typeof publishSubagentRunPostimages> | undefined;
    try {
      await Promise.race([wakeReached.promise, wake]);
      staging = publishSubagentRunPostimages({
        runs: subagentRuns,
        previous: new Map([[entry, captureSubagentRunMutationSnapshot(entry)]]),
        context,
        assertCurrent: () => {},
        persist: (source, callbacks, ...ids) =>
          persistSubagentRunsToDiskAsyncOrThrow(subagentRuns, ids, {
            context: source,
            ...callbacks,
          }),
      });
      await Promise.race([ackReached.promise, staging]);
      releaseWake.resolve();
      expect(await wakeResult).toEqual({ value: { applied: true, publication: "published" } });
      releaseAck.resolve();
      await expect(staging).resolves.toEqual({ outcome: "committed", publication: "superseded" });
      expect(entry.requesterSettleWake?.status).toBe("dispatching");
      expect(loadSubagentRegistryFromSqlite().get(entry.runId)?.requesterSettleWake?.status).toBe(
        "dispatching",
      );
    } finally {
      releaseWake.resolve();
      releaseAck.resolve();
      await Promise.allSettled([wake, staging]);
      held.mockRestore();
      subagentRuns.delete(entry.runId);
    }
  });
});

it("keeps a known requester wake commit while native staging waits for its acknowledgement", async () => {
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
    subagentRuns.set(entry.runId, entry);
    const unexpected = (): never => {
      throw new Error("Unexpected lifecycle side effect");
    };
    const context: SubagentLifecycleWakeContext = {
      options: {
        runs: subagentRuns,
        resumedRuns: new Set(),
        subagentAnnounceTimeoutMs: 1_000,
        getRuntimeConfig: () => ({}),
        persist: unexpected,
        persistOrThrow: unexpected,
        persistAsyncOrThrow: (source, callbacks, ...ids) =>
          persistSubagentRunsToDiskAsyncOrThrow(subagentRuns, ids, {
            context: source,
            ...callbacks,
          }),
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
      scheduledRequesterSettleWakeRuns: new WeakSet(),
      pendingRequesterSettleWakeRearms: new WeakSet(),
      pendingRequesterSettleWakeCommits: new WeakMap(),
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
    const previous = new Map([[entry, captureSubagentRunMutationSnapshot(entry)]]);
    entry.cleanupHandled = true;
    const publication = publishSubagentRunPostimages({
      runs: subagentRuns,
      previous,
      context: owner,
      assertCurrent: () => {
        if (subagentRuns.get(entry.runId) !== entry) {
          throw new Error("Registry row changed");
        }
      },
      persist: (source, callbacks, ...ids) =>
        persistSubagentRunsToDiskAsyncOrThrow(subagentRuns, ids, { context: source, ...callbacks }),
    });
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
      expect(await publication).toEqual({ outcome: "committed", publication: "published" });
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
