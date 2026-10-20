import { onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { subscribeSubagentRunChanges } from "./subagent-registry-publication.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import * as mod from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const flushAsync = () => vi.dynamicImportSettled();
const findRun = (requester: string, runId: string) =>
  mod.listSubagentRunsForRequester(requester).find((run) => run.runId === runId);

export function createLifecycleAgentCallWaits(
  requesterSessionKey: string,
  getAgentCallCount: () => number,
) {
  let agentCallObserved = createDeferred();
  const settleRootWork = observeRootWork();
  let pendingRootWork = Promise.resolve();
  return {
    notifyAgentCall() {
      agentCallObserved.resolve();
      agentCallObserved = createDeferred();
    },
    async waitForAgentCallCount(expectedCount: number) {
      await vi.advanceTimersByTimeAsync(0);
      const entered = async () => {
        while (getAgentCallCount() < expectedCount) {
          await agentCallObserved.promise;
        }
      };
      // Retain serial producer joins for teardown even when RPC entry wins.
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
      // RPC entry may precede persistence; join without advancing retry time.
      await pendingRootWork;
      const run = findRun(requesterSessionKey, runId);
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
  // Await publication, not a polling deadline that races native worker writes.
  const waitForRun = async (runId: string, matches: (run: SubagentRunRecord) => boolean) => {
    const reached = createDeferred<SubagentRunRecord>();
    const observe = () => {
      const run = findRun(requesterSessionKey, runId);
      if (run && matches(run)) {
        reached.resolve(run);
      }
    };
    const stop = subscribeSubagentRunChanges("projection", observe);
    onTestFinished(stop);
    try {
      observe();
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

  return {
    flushAsync,
    waitForRun,
    waitForDeliveredCleanup,
    waitForFrozenResult,
    waitForFrozenResultText: (runId: string, expectedText: string) =>
      waitForFrozenResult(runId, (resultText) => resultText === expectedText),
  };
}
