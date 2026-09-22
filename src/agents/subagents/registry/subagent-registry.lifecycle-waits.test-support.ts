import { vi } from "vitest";
import * as mod from "./subagent-registry.test-helpers.js";

export function createLifecycleWaits(requesterSessionKey: string) {
  const flushAsync = () => vi.dynamicImportSettled();

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
