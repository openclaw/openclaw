import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../shared/deferred.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
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
import { persistSubagentRunsToDiskAsyncOrThrow } from "./subagent-registry-state.js";

vi.mock("./subagent-registry-lifecycle-delivery.js", () => ({
  maskLifecycleIdentifier: () => "synthetic",
}));

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
        countPendingDescendantRuns: () => 0,
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
