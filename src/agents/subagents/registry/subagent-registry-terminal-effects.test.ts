import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withinTest } from "../../../../test/helpers/promise.js";
import { captureRuntimeConfigAsyncReader } from "../../../config/config.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import { SqliteWorkerError } from "../../../infra/sqlite-worker-contract.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { retireSessionMcpRuntime } from "../../agent-bundle-mcp-tools.js";
import { SUBAGENT_ENDED_REASON_COMPLETE } from "./subagent-lifecycle-events.js";
import { persistSubagentSessionTiming } from "./subagent-registry-helpers.js";
import {
  createLifecycleControllerFixture,
  createRunEntry,
  mutateLifecycleRun,
  readLifecycleRun,
  type LifecycleControllerFixtureOptions,
} from "./subagent-registry-lifecycle-controller.test-support.js";
import * as lifecyclePersistence from "./subagent-registry-lifecycle-persistence.js";
import {
  restoreSubagentRunsFromDisk,
  SubagentRegistryMutationRejectedError,
} from "./subagent-registry-persistence.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

vi.mock("./subagent-registry-helpers.js", { spy: true });
// mock-isolation: Resource dispatch tests do not create process-wide MCP runtimes.
vi.mock("../../agent-bundle-mcp-tools.js", () => ({
  retireSessionMcpRuntime: vi.fn(async () => true),
}));

beforeEach(async () => {
  await captureRuntimeConfigAsyncReader()();
  resetGatewayWorkAdmission();
  vi.mocked(persistSubagentSessionTiming).mockResolvedValue(undefined);
  vi.mocked(retireSessionMcpRuntime).mockClear();
});

function fixture(
  options: LifecycleControllerFixtureOptions,
  cleanupBrowser = vi.fn(async () => {}),
) {
  const controller = createLifecycleControllerFixture(options, {
    callGateway: async () => {
      throw new Error("Unexpected Gateway call");
    },
    cleanupBrowserSessionsForLifecycleEnd: cleanupBrowser,
    ownersByEntry: new Map(),
  });
  setRuntimeConfigSnapshot(controller.options.getRuntimeConfig());
  return {
    controller,
    cleanupBrowser,
    read: () => readLifecycleRun(options.entry),
    complete: (overrides: Partial<Parameters<typeof controller.completeSubagentRun>[0]> = {}) =>
      controller.completeSubagentRun({
        runId: options.entry.runId,
        endedAt: 4_000,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        triggerCleanup: true,
        ...overrides,
      }),
  };
}

it("retires a terminal callback when another completion replaces its session-effects binding", async ({
  signal,
}) => {
  const entry = createRunEntry({ expectsCompletionMessage: false });
  const progressEntered = createDeferredCore();
  const releaseProgress = createDeferredCore();
  const { controller, cleanupBrowser, complete } = fixture({
    entry,
    callGateway: vi.fn(),
    emitSubagentProgressEndedForRun: async () => {
      progressEntered.resolve();
      await releaseProgress.promise;
    },
  });
  const announce = vi.spyOn(controller, "startSubagentAnnounceCleanupFlow").mockReturnValue(false);
  const createSessionEffects = () => ({
    isCurrent: async () => true,
    assertHostCurrent: () => {},
    assertCurrentEntry: () => {},
  });
  const first = complete({ sessionEffects: createSessionEffects() });
  try {
    await withinTest(progressEntered.promise, signal);
    await complete({ sessionEffects: createSessionEffects() });
    releaseProgress.resolve();
    await first;
    expect(announce).toHaveBeenCalledOnce();
    expect(cleanupBrowser).toHaveBeenCalledOnce();
  } finally {
    releaseProgress.resolve();
    await first;
  }
});

it.each(["keep", "delete", "quiet", "suppressed"] as const)(
  "publishes %s cleanup before waking the requester",
  async (mode) => {
    const delivering = mode === "keep" || mode === "delete";
    const suppressed = mode === "suppressed";
    const entry = createRunEntry(
      delivering
        ? {
            childSessionKey: "global",
            childAgentId: "worker",
            expectsCompletionMessage: true,
            cleanup: mode,
          }
        : {
            expectsCompletionMessage: suppressed,
            suppressCompletionDelivery: suppressed || undefined,
            wakeOnDescendantSettle: true,
            endedAt: 4_000,
            endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
            outcome: { status: "ok" },
            delivery: {
              status: "pending",
              disposition: suppressed ? "intentional_non_delivery" : undefined,
              createdAt: 3_000,
              attemptCount: 2,
              nextAttemptAt: 5_000,
            },
          },
    );
    const writes: SubagentRunRecord[] = [];
    const wake = vi.fn(async () => {
      if (!delivering) {
        expect(readLifecycleRun(entry)).toMatchObject({
          cleanupCompletedAt: expect.any(Number),
          delivery: { status: "not_required" },
          requesterSettleWake: { status: "pending" },
        });
        expect(readLifecycleRun(entry).delivery?.attemptCount).toBeUndefined();
      }
      return false;
    });
    const { controller, cleanupBrowser, complete, read } = fixture({
      entry,
      callGateway: vi.fn(),
      maybeWakeRequesterAfterAllChildrenSettled: wake,
      beforeWrite: ({ postimages }) => {
        const row = postimages.get(entry.runId);
        if (row) {
          writes.push(row);
        }
      },
    });
    const settleRoots = observeRootWork();
    try {
      if (delivering) {
        await complete({ endedAt: Date.now() });
      } else {
        expect(controller.startSubagentAnnounceCleanupFlow(entry)).toBe(true);
      }
    } finally {
      await settleRoots();
    }

    const completed = read();
    expect(wake).toHaveBeenCalledTimes(suppressed ? 0 : 1);
    expect(completed.cleanupCompletedAt).toBeTypeOf("number");
    if (delivering) {
      expect(controller.options.runSubagentAnnounceFlow).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          childSessionKey: "global",
          childAgentId: "worker",
          cleanup: mode,
        }),
      );
      expect(controller.options.notifyContextEngineSubagentEnded).toHaveBeenCalledOnce();
      for (const reason of ["subagent-run-complete", "subagent-run-cleanup"]) {
        expect(retireSessionMcpRuntime).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: "session-id", reason }),
        );
      }
      expect(completed).toMatchObject({
        delivery: { status: "delivered" },
        requesterSettleWake: { status: "pending" },
        browserCleanupDispatchedAt: expect.any(Number),
      });
      expect(completed.requesterSettleWake?.retireAfterSettle).toBe(
        mode === "delete" ? true : undefined,
      );
      expect(cleanupBrowser).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ sessionKeys: ["agent:worker:global"] }),
      );
      return;
    }
    for (const row of writes) {
      if (row.delivery?.attemptCount === undefined) {
        expect(row.cleanupCompletedAt).toBeTypeOf("number");
      }
    }
    expect([completed.suppressCompletionDelivery, completed.wakeOnDescendantSettle]).toEqual([
      undefined,
      undefined,
    ]);
    expect(completed.delivery).toEqual({
      status: "not_required",
      ...(suppressed ? { disposition: "intentional_non_delivery" } : {}),
    });
    expect(controller.options.runSubagentAnnounceFlow).not.toHaveBeenCalled();
  },
);

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
    const cleanupBrowser = vi.fn(async () => {});
    const { controller, complete, read } = fixture(
      {
        entry,
        cleanupBrowserSessionsForLifecycleEnd: undefined,
        loadCleanupBrowserSessionsForLifecycleEnd: async () => {
          loaderEntered.resolve();
          await releaseLoader.promise;
          return cleanupBrowser;
        },
        beforeWrite: async () => {
          if (holdNextWrite) {
            holdNextWrite = false;
            writeEntered.resolve();
            await releaseWrite.promise;
          }
        },
      },
      cleanupBrowser,
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
    const completion = complete();
    let pendingWrite: Promise<void> | undefined;
    try {
      await withinTest(loaderEntered.promise, signal);
      holdNextWrite = true;
      if (barrier === "queued") {
        pendingWrite = mutateLifecycleRun(entry, (row) => {
          row.label = "preceding durable write";
        });
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

      expect(retireSupersededRun).toHaveBeenCalledExactlyOnceWith(entry.runId, read());
      expect(read().browserCleanupDispatchedAt).toBeUndefined();
      expect(controller.options.runs.get(successor.runId)).toBe(successor);
      expect(cleanupBrowser).not.toHaveBeenCalled();
      expect(announce).not.toHaveBeenCalled();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    } finally {
      releaseLoader.resolve();
      releaseWrite.resolve();
      await Promise.allSettled([completion, pendingWrite]);
    }
  },
);
afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
});

it.each([
  [
    "persistence error with the same message",
    new Error("Subagent browser cleanup lost its original owner"),
    "not-committed",
  ],
  [
    "authority rejection",
    new SubagentRegistryMutationRejectedError("Registry authority retired"),
    "not-committed",
  ],
  [
    "unknown write outcome",
    new SqliteWorkerError("Browser cleanup claim acknowledgement lost", "outcome-unknown"),
    "unknown",
  ],
] as const)("preserves a browser cleanup claim's %s", async (name, error, outcome) => {
  const entry = createRunEntry({ runId: `run-${name}`, expectsCompletionMessage: false });
  const { controller, cleanupBrowser, complete, read } = fixture({
    entry,
    beforeWrite: ({ postimages }) => {
      if (postimages.get(entry.runId)?.browserCleanupDispatchedAt !== undefined) {
        throw error;
      }
    },
  });
  const announce = vi.spyOn(controller, "startSubagentAnnounceCleanupFlow").mockReturnValue(false);
  try {
    await expect(complete()).rejects.toMatchObject({ cause: error, outcome });
    expect(read().browserCleanupDispatchedAt).toBeUndefined();
    expect(cleanupBrowser).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  } finally {
    if (outcome === "unknown") {
      await restoreSubagentRunsFromDisk({ runs: controller.options.runs });
    }
  }
});
