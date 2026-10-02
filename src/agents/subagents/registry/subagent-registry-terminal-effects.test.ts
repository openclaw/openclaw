import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withinTest } from "../../../../test/helpers/promise.js";
import { SqliteWorkerError } from "../../../infra/sqlite-worker-contract.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { SUBAGENT_ENDED_REASON_COMPLETE } from "./subagent-lifecycle-events.js";
import { persistSubagentSessionTiming } from "./subagent-registry-helpers.js";
import {
  createLifecycleControllerFixture,
  createRunEntry,
  mutateLifecycleRun,
  readLifecycleRun,
} from "./subagent-registry-lifecycle-controller.test-support.js";
import * as lifecyclePersistence from "./subagent-registry-lifecycle-persistence.js";
import {
  restoreSubagentRunsFromDisk,
  SubagentRegistryMutationRejectedError,
} from "./subagent-registry-persistence.js";

vi.mock("./subagent-registry-helpers.js", { spy: true });
vi.mock("../../agent-bundle-mcp-tools.js", () => ({
  retireSessionMcpRuntimeForSessionKey: vi.fn(async () => true),
}));

beforeEach(() => {
  resetGatewayWorkAdmission();
  vi.mocked(persistSubagentSessionTiming).mockResolvedValue(undefined);
});

it.for(["queued", "pre-commit"] as const)(
  "retires a superseded session while its browser cleanup claim waits (%s)",
  async (barrier, { signal }) => {
    const entry = createRunEntry({ generation: 1, expectsCompletionMessage: false });
    const loaderEntered = createDeferredCore();
    const releaseLoader = createDeferredCore();
    const writeEntered = createDeferredCore();
    const releaseWrite = createDeferredCore();
    const cleanupQueued = createDeferredCore();
    let holdNextWrite = false;
    const cleanupBrowserSessionsForLifecycleEnd = vi.fn(async () => {});
    const controller = createLifecycleControllerFixture(
      {
        entry,
        cleanupBrowserSessionsForLifecycleEnd: undefined,
        loadCleanupBrowserSessionsForLifecycleEnd: async () => {
          loaderEntered.resolve();
          await releaseLoader.promise;
          return cleanupBrowserSessionsForLifecycleEnd;
        },
        beforeWrite: async () => {
          if (holdNextWrite) {
            holdNextWrite = false;
            writeEntered.resolve();
            await releaseWrite.promise;
          }
        },
      },
      {
        callGateway: async () => {
          throw new Error("Unexpected Gateway call");
        },
        cleanupBrowserSessionsForLifecycleEnd,
        ownersByEntry: new Map(),
      },
    );
    const retireSupersededRun = vi.spyOn(controller.options, "retireSupersededRun");
    const announce = vi
      .spyOn(controller, "startSubagentAnnounceCleanupFlow")
      .mockReturnValue(false);
    const commit = lifecyclePersistence.commitSubagentLifecycleMutation;
    vi.spyOn(lifecyclePersistence, "commitSubagentLifecycleMutation").mockImplementation(
      (context, args) => {
        const pending = commit(context, args);
        if (args.onPublished) {
          cleanupQueued.resolve();
        }
        return pending;
      },
    );
    const completion = controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: true,
    });
    let pendingWrite: Promise<void> | undefined;
    try {
      await withinTest(loaderEntered.promise, signal);
      holdNextWrite = true;
      if (barrier === "queued") {
        pendingWrite = mutateLifecycleRun(entry, () => {});
        await withinTest(writeEntered.promise, signal);
      }
      releaseLoader.resolve();
      await withinTest(cleanupQueued.promise, signal);
      if (barrier === "pre-commit") {
        await withinTest(writeEntered.promise, signal);
      }
      const successor = createRunEntry({
        runId: "successor-run",
        childSessionKey: entry.childSessionKey,
        generation: 2,
        createdAt: 5_000,
      });
      controller.options.runs.set(successor.runId, successor);
      expect(controller.newerGenerationOwnsSession(entry)).toBe(true);
      releaseWrite.resolve();
      await pendingWrite;
      await expect(completion).resolves.toBeUndefined();

      expect(retireSupersededRun).toHaveBeenCalledExactlyOnceWith(
        entry.runId,
        readLifecycleRun(entry),
      );
      expect(readLifecycleRun(entry).browserCleanupDispatchedAt).toBeUndefined();
      expect(controller.options.runs.get(successor.runId)).toBe(successor);
      expect(cleanupBrowserSessionsForLifecycleEnd).not.toHaveBeenCalled();
      expect(announce).not.toHaveBeenCalled();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    } finally {
      releaseLoader.resolve();
      releaseWrite.resolve();
      await Promise.allSettled([completion, pendingWrite]);
    }
  },
);
afterEach(() => vi.restoreAllMocks());

it.each([
  {
    name: "persistence error with the same message",
    error: new Error("Subagent browser cleanup lost its original owner"),
    outcome: "not-committed",
  },
  {
    name: "authority rejection",
    error: new SubagentRegistryMutationRejectedError("Registry authority retired"),
    outcome: "not-committed",
  },
  {
    name: "unknown write outcome",
    error: new SqliteWorkerError("Browser cleanup claim acknowledgement lost", "outcome-unknown"),
    outcome: "unknown",
  },
])("preserves a browser cleanup claim's $name", async ({ error, outcome, name }) => {
  const entry = createRunEntry({ runId: `run-${name}`, expectsCompletionMessage: false });
  const cleanupBrowserSessionsForLifecycleEnd = vi.fn(async () => {});
  const controller = createLifecycleControllerFixture(
    {
      entry,
      beforeWrite: ({ postimages }) => {
        if (postimages.get(entry.runId)?.browserCleanupDispatchedAt !== undefined) {
          throw error;
        }
      },
    },
    {
      callGateway: async () => {
        throw new Error("Unexpected Gateway call");
      },
      cleanupBrowserSessionsForLifecycleEnd,
      ownersByEntry: new Map(),
    },
  );
  const announce = vi.spyOn(controller, "startSubagentAnnounceCleanupFlow").mockReturnValue(false);
  try {
    await expect(
      controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: 4_000,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        triggerCleanup: true,
      }),
    ).rejects.toMatchObject({ cause: error, outcome });
    expect(readLifecycleRun(entry).browserCleanupDispatchedAt).toBeUndefined();
    expect(cleanupBrowserSessionsForLifecycleEnd).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  } finally {
    if (outcome === "unknown") {
      await restoreSubagentRunsFromDisk({ runs: controller.options.runs });
    }
  }
});

it("retires a browser cleanup queued behind a newer terminal publication", async ({ signal }) => {
  const entry = createRunEntry({ expectsCompletionMessage: false });
  const loaderEntered = createDeferredCore();
  const releaseLoader = createDeferredCore();
  const successorWriteEntered = createDeferredCore();
  const releaseSuccessorWrite = createDeferredCore();
  const cleanupQueued = createDeferredCore();
  const cleanupBrowserSessionsForLifecycleEnd = vi.fn(async () => {});
  const controller = createLifecycleControllerFixture(
    {
      entry,
      cleanupBrowserSessionsForLifecycleEnd: undefined,
      loadCleanupBrowserSessionsForLifecycleEnd: async () => {
        loaderEntered.resolve();
        await releaseLoader.promise;
        return cleanupBrowserSessionsForLifecycleEnd;
      },
      beforeWrite: async ({ postimages }) => {
        const next = postimages.get(entry.runId);
        if (next?.execution.endedAt === 4_001 && next.browserCleanupDispatchedAt === undefined) {
          successorWriteEntered.resolve();
          await releaseSuccessorWrite.promise;
        }
      },
    },
    {
      callGateway: async () => {
        throw new Error("Unexpected Gateway call");
      },
      cleanupBrowserSessionsForLifecycleEnd,
      ownersByEntry: new Map(),
    },
  );
  const announce = vi.spyOn(controller, "startSubagentAnnounceCleanupFlow").mockReturnValue(false);
  const commit = lifecyclePersistence.commitSubagentLifecycleMutation;
  vi.spyOn(lifecyclePersistence, "commitSubagentLifecycleMutation").mockImplementation(
    (context, args) => {
      const pending = commit(context, args);
      // Observe the real FIFO reservation without changing its admission or write.
      if (args.onPublished) {
        cleanupQueued.resolve();
      }
      return pending;
    },
  );
  const params = {
    runId: entry.runId,
    endedAt: 4_000,
    outcome: { status: "ok" as const },
    reason: SUBAGENT_ENDED_REASON_COMPLETE,
    triggerCleanup: true,
  };
  const first = controller.completeSubagentRun(params);
  let successor: Promise<void> | undefined;
  try {
    await withinTest(loaderEntered.promise, signal);
    successor = controller.completeSubagentRun({ ...params, endedAt: 4_001 });
    await withinTest(successorWriteEntered.promise, signal);
    releaseLoader.resolve();
    await withinTest(cleanupQueued.promise, signal);

    expect(readLifecycleRun(entry).browserCleanupDispatchedAt).toBeUndefined();
    expect(cleanupBrowserSessionsForLifecycleEnd).not.toHaveBeenCalled();
    releaseSuccessorWrite.resolve();
    await expect(first).resolves.toBeUndefined();
    await successor;

    expect(readLifecycleRun(entry).execution.endedAt).toBe(4_001);
    expect(readLifecycleRun(entry).browserCleanupDispatchedAt).toBeTypeOf("number");
    expect(cleanupBrowserSessionsForLifecycleEnd).toHaveBeenCalledOnce();
    expect(announce).toHaveBeenCalledOnce();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  } finally {
    releaseLoader.resolve();
    releaseSuccessorWrite.resolve();
    await Promise.allSettled([first, successor]);
  }
});
