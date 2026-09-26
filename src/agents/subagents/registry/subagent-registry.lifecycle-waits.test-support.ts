import { vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { getTaskRegistryProcessState } from "../../../tasks/task-registry.process-state.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import * as mod from "./subagent-registry.test-helpers.js";

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
  const flushAsync = async () => {
    await vi.dynamicImportSettled();
    // Fake-time polling does not join native worker commits. Delivery can enqueue
    // another task mutation after terminal settlement, so drain each accepted tail.
    for (
      let pending = getTaskRegistryProcessState().projection.mutationTail;
      pending;
      pending = getTaskRegistryProcessState().projection.mutationTail
    ) {
      await pending;
      await vi.dynamicImportSettled();
    }
  };

  const waitForCleanupHandledFalse = async (runId: string) => {
    // Cleanup can be released asynchronously after announce failure; poll fake
    // time until the retry-grace state is observable.
    for (let attempt = 0; attempt < 40; attempt += 1) {
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
      await vi.advanceTimersByTimeAsync(1);
      await flushAsync();
    }
    throw new Error(`run ${runId} did not reach cleanupHandled=false in time`);
  };

  const waitForDeliveredCleanup = async (
    runId: string,
    options?: { allowPendingRequesterSettleWake?: boolean },
  ) => {
    let lastRun: ReturnType<typeof mod.listSubagentRunsForRequester>[number] | undefined;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const run = mod
        .listSubagentRunsForRequester(requesterSessionKey)
        .find((candidate) => candidate.runId === runId);
      lastRun = run;
      if (
        run?.delivery?.status === "delivered" &&
        typeof run.cleanupCompletedAt === "number" &&
        (options?.allowPendingRequesterSettleWake === true || run.requesterSettleWake === undefined)
      ) {
        return;
      }
      await vi.advanceTimersByTimeAsync(1);
      await flushAsync();
    }
    throw new Error(
      `run ${runId} did not finish delivered cleanup in time: ${JSON.stringify({
        cleanupCompletedAt: lastRun?.cleanupCompletedAt,
        delivery: lastRun?.delivery,
        requesterSettleWake: lastRun?.requesterSettleWake,
      })}`,
    );
  };

  const waitForFrozenResult = async (runId: string, matches: (resultText: string) => boolean) => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const run = mod
        .listSubagentRunsForRequester(requesterSessionKey)
        .find((candidate) => candidate.runId === runId);
      const resultText = run?.completion?.resultText;
      if (run && typeof resultText === "string" && matches(resultText)) {
        return run;
      }
      await vi.advanceTimersByTimeAsync(1);
      await flushAsync();
    }
    throw new Error(`run ${runId} frozen result did not refresh`);
  };

  const waitForFrozenResultText = async (runId: string, expectedText: string) =>
    waitForFrozenResult(runId, (resultText) => resultText === expectedText);

  return {
    flushAsync,
    waitForCleanupHandledFalse,
    waitForDeliveredCleanup,
    waitForFrozenResult,
    waitForFrozenResultText,
  };
}
