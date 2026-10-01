import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import type {
  CodeModeExecutorContinuation,
  CodeModeWorkerResult,
} from "./code-mode-executor-types.js";
import { EMPTY_CODE_MODE_OUTPUT } from "./code-mode-json.js";
import { resolveCodeModeConfig } from "./code-mode-runtime.js";
import { createCodeModeRunOwner, disposeAllCodeModeRuns } from "./code-mode-state.js";
import {
  captureAgentPluginRuntimeRefresh,
  createAgentPluginRuntimeRefresh,
} from "./plugin-runtime-refresh.js";
import {
  clearToolSearchCatalog,
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
} from "./tool-search-catalog.js";

function createOwner(abortSignal?: AbortSignal) {
  const config = { tools: { codeMode: true } };
  const catalogRef = createToolSearchCatalogRef();
  registerHeadlessToolSearchCatalog({ catalogRef, tools: [] });
  const ctx = { config, runtimeConfig: config, catalogRef, abortSignal };
  return { owner: createCodeModeRunOwner(ctx, resolveCodeModeConfig(config)), ctx };
}

function controlledContinuation() {
  const started = createDeferredCore();
  const release = createDeferredCore();
  const continuation: CodeModeExecutorContinuation = {
    executor: "node",
    retainedBytes: 1,
    resume: async () => {
      throw new Error("The test does not resume its guest.");
    },
    dispose: vi.fn(async () => {
      started.resolve();
      await release.promise;
    }),
  };
  return { continuation, started, release };
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
  it("revokes authority immediately and delays plugin refresh until physical cleanup completes", async () => {
    const refresh = createAgentPluginRuntimeRefresh();
    try {
      await refresh.run(async () => {
        const refreshState = captureAgentPluginRuntimeRefresh();
        refreshState.bindConsumer(() => true);
        const { owner } = createOwner();
        const parked = controlledContinuation();
        const reply = owner.inbox.createReply("pending");
        try {
          await owner.retainContinuation(parked.continuation);
          expect(refreshState.request()).toBe(true);
          const closing = owner.close();
          expect(owner.close()).toBe(closing);
          expect(owner.signal.aborted).toBe(true);
          reply.settle(true, "late result");
          expect(() => reply.take()).toThrow("Code Mode reply is unavailable");
          await parked.started.promise;
          expect(refreshState.isPending()).toBe(false);

          parked.release.resolve();
          await closing;
          expect(refreshState.isPending()).toBe(true);
          expect(parked.continuation.dispose).toHaveBeenCalledOnce();
        } finally {
          parked.release.resolve();
          await owner.close();
        }
      });
    } finally {
      refresh.close();
    }
  });

  it.each(["catalog", "abort"] as const)(
    "joins an in-flight worker and disposes its late continuation after %s revocation",
    async (reason) => {
      const refresh = createAgentPluginRuntimeRefresh();
      try {
        await refresh.run(async () => {
          const refreshState = captureAgentPluginRuntimeRefresh();
          refreshState.bindConsumer(() => true);
          const abort = new AbortController();
          const { owner, ctx } = createOwner(abort.signal);
          const workerStarted = createDeferredCore();
          const workerResult = createDeferredCore<CodeModeWorkerResult>();
          const parked = controlledContinuation();
          const execution = owner.runExecution(async () => {
            workerStarted.resolve();
            return await workerResult.promise;
          });
          try {
            await workerStarted.promise;
            refreshState.request();
            if (reason === "catalog") {
              clearToolSearchCatalog(ctx);
            } else {
              abort.abort();
            }
            expect(owner.signal.aborted).toBe(true);
            const closing = owner.close();
            expect(refreshState.isPending()).toBe(false);
            workerResult.resolve(waiting(parked.continuation));
            await parked.started.promise;
            expect(refreshState.isPending()).toBe(false);

            parked.release.resolve();
            await Promise.all([execution, closing]);
            expect(parked.continuation.dispose).toHaveBeenCalledOnce();
            expect(refreshState.isPending()).toBe(true);
            const staleExecution = vi.fn(async () => waiting(parked.continuation));
            await expect(owner.runExecution(staleExecution)).rejects.toThrow();
            expect(staleExecution).not.toHaveBeenCalled();
          } finally {
            workerResult.resolve(waiting(parked.continuation));
            parked.release.resolve();
            await Promise.allSettled([execution, owner.close()]);
          }
        });
      } finally {
        refresh.close();
      }
    },
  );

  it("revokes every run before Gateway shutdown waits for their cleanup", async () => {
    const first = createOwner().owner;
    const second = createOwner().owner;
    const firstParked = controlledContinuation();
    const secondParked = controlledContinuation();
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

  it("retries failed cleanup without reviving authority or releasing plugin refresh early", async () => {
    const refresh = createAgentPluginRuntimeRefresh();
    try {
      await refresh.run(async () => {
        const refreshState = captureAgentPluginRuntimeRefresh();
        refreshState.bindConsumer(() => true);
        const { owner } = createOwner();
        const parked = controlledContinuation();
        const failure = new Error("worker termination failed");
        vi.mocked(parked.continuation.dispose).mockRejectedValueOnce(failure);
        try {
          await owner.retainContinuation(parked.continuation);
          refreshState.request();
          const firstClose = owner.close();
          await expect(firstClose).rejects.toMatchObject({ cause: { errors: [failure] } });
          expect(owner.signal.aborted).toBe(true);
          expect(refreshState.isPending()).toBe(false);

          expect(owner.close()).not.toBe(firstClose);
          const retry = disposeAllCodeModeRuns();
          await parked.started.promise;
          expect(owner.bindCall().aborted).toBe(true);
          expect(refreshState.isPending()).toBe(false);
          parked.release.resolve();
          await retry;
          expect(refreshState.isPending()).toBe(true);
          expect(parked.continuation.dispose).toHaveBeenCalledTimes(2);
          const staleExecution = vi.fn(async () => waiting(parked.continuation));
          await expect(owner.runExecution(staleExecution)).rejects.toThrow();
          expect(staleExecution).not.toHaveBeenCalled();
          await disposeAllCodeModeRuns();
          expect(parked.continuation.dispose).toHaveBeenCalledTimes(2);
        } finally {
          parked.release.resolve();
          await owner.close();
        }
      });
    } finally {
      refresh.close();
    }
  });
});
