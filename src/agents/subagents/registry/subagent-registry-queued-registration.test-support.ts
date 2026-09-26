import { vi, type Mock } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { RegisterSubagentRunParams } from "./subagent-registry-run-launch-record.js";
import type { SubagentLaunchManager } from "./subagent-registry-run-launch.js";
import { createSubagentRunManager } from "./subagent-registry-run-manager.js";
import type { SubagentManagerOptions } from "./subagent-registry-run-wait.js";
import type { SubagentRegistrationScope, SubagentRunRecord } from "./subagent-registry.types.js";

export function createQueuedRegistrationFixture(
  mocks: {
    register: Mock<SubagentLaunchManager["registerSubagentRun"]>;
    persisted: Set<() => void>;
  },
  runs = new Map<string, SubagentRunRecord>(),
) {
  let syncRevision = 0;
  let acknowledgeAll = false;
  const writes: Array<{
    gate: ReturnType<typeof createDeferred<void>>;
    snapshot: Map<string, SubagentRunRecord>;
    assertCurrent: () => void;
    afterPublicationFailure?: { error: unknown };
  }> = [];
  const writeWaiters = new Map<number, ReturnType<typeof createDeferred<void>>>();
  const persist = vi.fn<SubagentManagerOptions["persistAsyncOrThrow"]>(
    (_context, callbacks, ...runIds) => {
      const gate = createDeferred();
      const admittedRevision = syncRevision;
      const write: (typeof writes)[number] = {
        gate,
        snapshot: structuredClone(callbacks.snapshot ?? runs),
        assertCurrent: callbacks.assertCurrent,
      };
      writes.push(write);
      writeWaiters.get(writes.length - 1)?.resolve();
      if (acknowledgeAll) {
        gate.resolve();
      }
      return gate.promise.then(() => {
        if (syncRevision === admittedRevision) {
          callbacks.onCommitted?.(runIds);
        }
        for (const listener of mocks.persisted) {
          listener();
        }
        if (write.afterPublicationFailure) {
          throw write.afterPublicationFailure.error;
        }
      });
    },
  );
  const options = {
    runs,
    getRunsForChildSession: (key) =>
      [...runs.values()].filter((entry) => entry.childSessionKey === key),
    resumedRuns: new Set(),
    persist: vi.fn(),
    persistOrThrow: vi.fn<SubagentManagerOptions["persistOrThrow"]>(() => {
      syncRevision += 1;
      for (const listener of mocks.persisted) {
        listener();
      }
    }),
    persistAsyncOrThrow: persist,
    callGateway: async () => {
      throw new Error("Unexpected Gateway call");
    },
    getRuntimeConfig: () => ({}),
    ensureListener: vi.fn(),
    startSweeper: vi.fn(),
    stopSweeper: vi.fn(),
    resumeSubagentRun: vi.fn(),
    clearPendingLifecycleError: vi.fn(),
    clearPendingLifecycleTimeout: vi.fn(),
    resolveSubagentWaitTimeoutMs: () => 100,
    scheduleSweep: vi.fn(),
    resolveSubagentSessionCompletion: () => null,
    resolveSubagentSessionStartedAt: () => undefined,
    notifyContextEngineSubagentEnded: async () => {},
    completeCleanupBookkeeping: vi.fn(),
    completeSubagentRun: async () => {},
    resolveSubagentTask: () => ({ lookup: "unavailable" }),
  } satisfies SubagentManagerOptions;
  const manager = createSubagentRunManager(options);
  mocks.register.mockImplementation(manager.registerSubagentRun);
  const registration: RegisterSubagentRunParams = {
    runId: "queued-original",
    childSessionKey: "agent:main:subagent:synthetic",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "synthetic queued work",
    cleanup: "keep",
    collect: true,
    queued: true,
    taskRowOwnership: "required",
    queuedLaunch: {
      request: { sessionKey: "agent:main:subagent:synthetic" },
      timeoutMs: 100,
      schedulerGroupKey: "group",
      maxConcurrent: 1,
    },
  };
  let scope: SubagentRegistrationScope | undefined;
  return {
    runs,
    writes,
    waitForWrite: async (index: number) => {
      if (!writes[index]) {
        const waiter = createDeferred();
        writeWaiters.set(index, waiter);
        await waiter.promise;
      }
      return writes[index]!;
    },
    options,
    manager,
    get persistenceObservers() {
      return mocks.persisted;
    },
    registration,
    acknowledgeAllWrites: () => {
      acknowledgeAll = true;
      for (const write of writes) {
        write.gate.resolve();
      }
    },
    get scope() {
      return scope!;
    },
    register: (assertCurrent?: () => void) =>
      manager.registerSubagentRun(registration, {
        assertCurrent,
        retainOwnership: (value) => {
          scope = value;
        },
      }),
  };
}
