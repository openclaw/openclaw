import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import type {
  CodeModeExecutorContinuation,
  CodeModeWorkerResult,
} from "./code-mode-executor-types.js";
import { EMPTY_CODE_MODE_OUTPUT } from "./code-mode-json.js";
import { createRunFixture } from "./code-mode-lifecycle.test-support.js";
import { disposeAllCodeModeRuns } from "./code-mode-state.js";
import {
  captureAgentPluginRuntimeRefresh,
  createAgentPluginRuntimeRefresh,
} from "./plugin-runtime-refresh.js";
import { clearToolSearchCatalog } from "./tool-search-catalog.js";

function controlledRun(abortSignal?: AbortSignal) {
  const started = createDeferredCore();
  const release = createDeferredCore();
  const dispose = async () => {
    started.resolve();
    await release.promise;
  };
  return { ...createRunFixture(undefined, dispose, abortSignal), started, release };
}

function waiting(continuation: CodeModeExecutorContinuation): CodeModeWorkerResult {
  return {
    status: "waiting",
    continuation,
    pendingRequests: [],
    canceledRequestIds: [],
    settlementMode: { kind: "awaiting" },
    output: EMPTY_CODE_MODE_OUTPUT,
  };
}

afterEach(async () => {
  await disposeAllCodeModeRuns();
});

describe("Code Mode continuation ownership", () => {
  it.each(["close", "retry", "catalog", "abort"] as const)("revokes %s", async (reason) => {
    const refresh = createAgentPluginRuntimeRefresh();
    try {
      await refresh.run(async () => {
        const refreshState = captureAgentPluginRuntimeRefresh();
        refreshState.bindConsumer(() => true);
        const abort = new AbortController();
        const parked = controlledRun(abort.signal);
        const { owner, ctx } = parked;
        const workerStarted = createDeferredCore();
        const workerResult = createDeferredCore<CodeModeWorkerResult>();
        const inFlight = reason === "catalog" || reason === "abort";
        const execution = inFlight
          ? owner.runExecution(async () => {
              workerStarted.resolve();
              return await workerResult.promise;
            })
          : undefined;
        const reply = owner.inbox.createReply("pending");
        const failure = new Error("worker termination failed");
        if (reason === "retry") {
          vi.mocked(parked.continuation.dispose).mockRejectedValueOnce(failure);
        }
        try {
          if (inFlight) {
            await workerStarted.promise;
          } else {
            await owner.retainContinuation(parked.continuation);
          }
          expect(refreshState.request()).toBe(true);
          if (reason === "catalog") {
            clearToolSearchCatalog(ctx);
          } else if (reason === "abort") {
            abort.abort();
          }
          expect(owner.signal.aborted).toBe(inFlight);
          const firstClose = owner.close();
          expect(owner.close()).toBe(firstClose);
          expect(owner.signal.aborted).toBe(true);
          reply.settle(true, "late result");
          expect(() => reply.take()).toThrow("Code Mode reply is unavailable");
          let closing = firstClose;
          if (reason === "retry") {
            await expect(firstClose).rejects.toMatchObject({ cause: { errors: [failure] } });
            expect(owner.signal.aborted).toBe(true);
            expect(refreshState.isPending()).toBe(false);
            expect(owner.close()).not.toBe(firstClose);
            closing = disposeAllCodeModeRuns();
          }
          if (inFlight) {
            expect(refreshState.isPending()).toBe(false);
            workerResult.resolve(waiting(parked.continuation));
          }
          await parked.started.promise;
          expect([owner.bindCall().aborted, refreshState.isPending()]).toEqual([true, false]);
          parked.release.resolve();
          await Promise.all([execution, closing]);
          expect(refreshState.isPending()).toBe(true);
          const calls = reason === "retry" ? 2 : 1;
          expect(parked.continuation.dispose).toHaveBeenCalledTimes(calls);
          const staleExecution = vi.fn(async () => waiting(parked.continuation));
          await expect(owner.runExecution(staleExecution)).rejects.toThrow();
          expect(staleExecution).not.toHaveBeenCalled();
          await disposeAllCodeModeRuns();
          expect(parked.continuation.dispose).toHaveBeenCalledTimes(calls);
        } finally {
          workerResult.resolve(waiting(parked.continuation));
          parked.release.resolve();
          await Promise.all([execution, owner.close()]);
        }
      });
    } finally {
      refresh.close();
    }
  });

  it("revokes every run before Gateway shutdown waits for their cleanup", async () => {
    const firstParked = controlledRun();
    const secondParked = controlledRun();
    const first = firstParked.owner;
    const second = secondParked.owner;
    try {
      await first.retainContinuation(firstParked.continuation);
      await second.retainContinuation(secondParked.continuation);
      const finished = vi.fn();
      const closing = disposeAllCodeModeRuns().then(finished);
      expect(first.signal.aborted).toBe(true);
      expect(second.signal.aborted).toBe(true);
      await Promise.all([firstParked.started.promise, secondParked.started.promise]);
      firstParked.release.resolve();
      await first.close();
      expect(finished).not.toHaveBeenCalled();

      secondParked.release.resolve();
      await closing;
      expect(finished).toHaveBeenCalledOnce();
    } finally {
      firstParked.release.resolve();
      secondParked.release.resolve();
      await disposeAllCodeModeRuns();
    }
  });
});
