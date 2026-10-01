import { onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { subscribeSubagentRunChanges } from "./subagent-registry-publication.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import * as mod from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function createLifecycleAgentCallWaits(
  requesterSessionKey: string,
  getAgentCallCount: () => number,
) {
  let agentCallObserved = createDeferred();
  const settleRootWork = observeRootWork();
  const { flushAsync } = createLifecycleWaits(requesterSessionKey);
  let pendingRootWork = Promise.resolve();
  return {
    notifyAgentCall() {
      agentCallObserved.resolve();
      agentCallObserved = createDeferred();
    },
    async waitForAgentCallCount(expectedCount: number) {
      // Start due callbacks without spending retry time waiting for native worker reads.
      await vi.advanceTimersByTimeAsync(0);
      const entered = async () => {
        while (getAgentCallCount() < expectedCount) {
          await agentCallObserved.promise;
        }
      };
      // RPC entry may beat a gated producer. Keep joins serial and retain the
      // loser for teardown; an early retryable result must fail, not trigger retries.
      pendingRootWork = pendingRootWork.then(() => settleRootWork(true));
      await Promise.race([entered(), pendingRootWork]);
      if (getAgentCallCount() >= expectedCount) {
        return;
      }
      const pending = mod.listSubagentRunsForRequester(requesterSessionKey).map((run) => ({
        runId: run.runId,
        execution: run.execution,
        delivery: run.delivery,
        requesterSettleWake: run.requesterSettleWake,
      }));
      throw new Error(
        `expected ${expectedCount} agent call(s), got ${getAgentCallCount()}: ${JSON.stringify(pending)}`,
      );
    },
    async waitForCleanupHandledFalse(runId: string) {
      // RPC entry can beat native persistence. Join its retained producer without
      // spending retry time or disposing observation of a corrected receipt.
      await pendingRootWork;
      const run = mod
        .listSubagentRunsForRequester(requesterSessionKey)
        .find((candidate) => candidate.runId === runId);
      if (
        run?.cleanupHandled === false &&
        run.delivery?.status === "pending" &&
        run.delivery.payload
      ) {
        return;
      }
      throw new Error(`run ${runId} did not reach deferred cleanup after producer settlement`);
    },
    async settle() {
      try {
        await pendingRootWork;
      } finally {
        try {
          await settleRootWork();
        } finally {
          await flushAsync();
        }
      }
    },
  };
}

export function createLifecycleWaits(requesterSessionKey: string) {
  const flushAsync = () => vi.dynamicImportSettled();

  const findRun = (runId: string) =>
    mod
      .listSubagentRunsForRequester(requesterSessionKey)
      .find((candidate) => candidate.runId === runId);

  // Registry mutations become observable when their writer publishes them.
  // Waiting on that signal has no attempt or wall-clock bound: a state that is
  // never published fails at the Vitest test timeout instead of losing a race
  // against native worker writes on a loaded runner.
  const waitForRun = async (runId: string, matches: (run: SubagentRunRecord) => boolean) => {
    const reached = createDeferred<SubagentRunRecord>();
    const observe = () => {
      const run = findRun(runId);
      if (run && matches(run)) {
        reached.resolve(run);
      }
    };
    const stop = subscribeSubagentRunChanges(observe);
    onTestFinished(stop);
    try {
      observe();
      // Start due callbacks without spending retry time waiting for native worker reads.
      await vi.advanceTimersByTimeAsync(0);
      return await reached.promise;
    } finally {
      stop();
    }
  };

  const waitForDeliveredCleanup = async (
    runId: string,
    options?: { allowPendingRequesterSettleWake?: boolean },
  ) => {
    await waitForRun(
      runId,
      (run) =>
        run.delivery?.status === "delivered" &&
        typeof run.cleanupCompletedAt === "number" &&
        (options?.allowPendingRequesterSettleWake === true ||
          run.requesterSettleWake === undefined),
    );
  };

  const waitForFrozenResult = (runId: string, matches: (resultText: string) => boolean) =>
    waitForRun(
      runId,
      (run) => typeof run.completion?.resultText === "string" && matches(run.completion.resultText),
    );

  const waitForFrozenResultText = (runId: string, expectedText: string) =>
    waitForFrozenResult(runId, (resultText) => resultText === expectedText);

  return {
    flushAsync,
    waitForDeliveredCleanup,
    waitForFrozenResult,
    waitForFrozenResultText,
  };
}
