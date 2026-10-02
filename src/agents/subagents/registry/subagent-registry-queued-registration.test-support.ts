import { vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type {
  SqliteWorkerAdmissionFactory,
  SqliteWorkerOperationAdmission,
} from "../../../infra/sqlite-worker-operation-admission.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { closeSwarmScheduler } from "../swarm/swarm-scheduler.js";
import { testing as schedulerTesting } from "../swarm/swarm-scheduler.test-support.js";
import {
  mutateSubagentRuns,
  restoreSubagentRunsFromDisk,
} from "./subagent-registry-persistence.js";
import type { RegisterSubagentRunParams } from "./subagent-registry-run-launch-record.js";
import { createSubagentRunManager } from "./subagent-registry-run-manager.js";
import type { SubagentManagerOptions } from "./subagent-registry-run-wait.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry.store.sqlite.js";
import type { SubagentRegistrationScope, SubagentRunRecord } from "./subagent-registry.types.js";

function createQueuedRegistrationFixture(runs = new Map<string, SubagentRunRecord>()) {
  const pending: Promise<unknown>[] = [];
  const track = <T>(work: T | Promise<T>): Promise<T> => {
    const promise = Promise.resolve(work);
    pending.push(promise);
    void promise.catch(() => {});
    return promise;
  };
  const holds: Array<{
    phase: "before" | "ack";
    entered: ReturnType<typeof createDeferred<void>>;
    gate: ReturnType<typeof createDeferred<void>>;
    loseNativeReceipt?: boolean;
  }> = [];
  const allHolds: typeof holds = [];
  const execute = stateWorker.runOpenClawStateWorkerOperation;
  let writes = 0;
  const worker = vi
    .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
    .mockImplementation((context, operation, options) => {
      let admission: SqliteWorkerOperationAdmission | undefined;
      const createAdmission = options?.createAdmission;
      return execute(
        context,
        (scope) =>
          operation({
            execute: async (command, executeOptions) => {
              if (command.type !== "subagents.persistChanges") {
                return scope.execute(command, executeOptions);
              }
              writes += 1;
              const hold = holds.shift();
              if (hold?.phase === "before") {
                hold.entered.resolve();
                await hold.gate.promise;
              }
              const receipt = await scope.execute(command, executeOptions);
              if (hold?.phase === "ack") {
                hold.entered.resolve();
                try {
                  await hold.gate.promise;
                } catch (error) {
                  if (hold.loseNativeReceipt && admission) {
                    // Losing only the transport reply is recoverable from this native receipt.
                    Object.defineProperty(admission, "committed", { value: undefined });
                  }
                  throw error;
                }
              }
              return receipt;
            },
          }),
        {
          ...options,
          ...(createAdmission
            ? {
                createAdmission: (nativeOperation: Parameters<SqliteWorkerAdmissionFactory>[0]) => {
                  const prepared = createAdmission(nativeOperation);
                  admission = prepared.admission;
                  return prepared;
                },
              }
            : {}),
        },
      );
    });
  const options = {
    runs,
    getRunsForChildSession: (key) =>
      [...runs.values()].filter((row) => row.childSessionKey === key),
    resumedRuns: new Set<object>(),
    acquireTerminalCompletionLock: async () => () => {},
    callGateway: async () => {
      throw new Error("Unexpected collector wait");
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
    resolveSubagentSessionCompletion: async () => null,
    resolveSubagentSessionStartedAt: async () => undefined,
    notifyContextEngineSubagentEnded: async () => {},
    completeCleanupBookkeeping: vi.fn(async () => {}),
    completeSubagentRun: async () => {},
  } satisfies SubagentManagerOptions;
  const manager = createSubagentRunManager(options);
  const registration: RegisterSubagentRunParams = {
    runId: "queued-original",
    childSessionKey: "agent:main:subagent:synthetic",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "synthetic queued work",
    cleanup: "keep",
    retainAttachmentsOnKeep: true,
    collect: true,
    queued: true,
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
    options,
    manager,
    registration,
    track,
    get writes() {
      return writes;
    },
    get scope() {
      if (!scope) {
        throw new Error("Queued intent has not published its scope");
      }
      return scope;
    },
    current: () => {
      const row = runs.get(registration.runId);
      if (!row) {
        throw new Error("Queued row has not published");
      }
      return row;
    },
    stored: () => loadSubagentRegistryFromSqlite().get(registration.runId),
    holdNextWrite: (phase: "before" | "ack" = "ack") => {
      const hold: (typeof holds)[number] = {
        phase,
        entered: createDeferred(),
        gate: createDeferred(),
      };
      holds.push(hold);
      allHolds.push(hold);
      return {
        entered: hold.entered.promise,
        release: hold.gate.resolve,
        reject: hold.gate.reject,
        loseReceipt: (error: unknown) => {
          hold.loseNativeReceipt = true;
          hold.gate.reject(error);
        },
      };
    },
    register: (assertCurrent?: () => void) =>
      track(
        manager.registerSubagentRun(registration, {
          assertCurrent,
          retainOwnership: (value) => {
            scope = value;
          },
        }),
      ),
    change: (plan: (draft: SubagentRunRecord) => void) =>
      track(
        mutateSubagentRuns(
          [registration.runId],
          (rows) => {
            const current = rows.get(registration.runId);
            if (!current) {
              throw new Error("Fixture row is absent");
            }
            const draft = structuredClone(current);
            plan(draft);
            return { value: undefined, postimages: new Map([[draft.runId, draft]]) };
          },
          { runs },
        ),
      ),
    async close() {
      for (const hold of allHolds) {
        hold.gate.resolve();
      }
      await Promise.allSettled(pending);
      await closeSwarmScheduler();
      worker.mockRestore();
      await restoreSubagentRunsFromDisk({ runs });
      runs.clear();
      schedulerTesting.reset();
    },
  };
}

export type QueuedRegistrationFixture = ReturnType<typeof createQueuedRegistrationFixture>;

export async function withQueuedRegistrationFixture(
  run: (fixture: QueuedRegistrationFixture) => Promise<void>,
  runs?: Map<string, SubagentRunRecord>,
): Promise<void> {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const fixture = createQueuedRegistrationFixture(runs);
    try {
      await run(fixture);
    } finally {
      await fixture.close();
    }
  });
}
