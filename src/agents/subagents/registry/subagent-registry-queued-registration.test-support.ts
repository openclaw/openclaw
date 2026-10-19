import assert from "node:assert/strict";
import { vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SqliteWorkerOperationAdmission } from "../../../infra/sqlite-worker-operation-admission.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createSubagentRunParams } from "../../subagent-test-fixtures.test-helpers.js";
import { closeSwarmScheduler } from "../swarm/swarm-scheduler.js";
import { testing as schedulerTesting } from "../swarm/swarm-scheduler.test-support.js";
import {
  mutateSubagentRuns,
  restoreSubagentRunsFromDisk,
} from "./subagent-registry-persistence.js";
import type { RegisterSubagentRunParams } from "./subagent-registry-run-launch-record.js";
import { createSubagentRunManager } from "./subagent-registry-run-manager.js";
import type { SubagentManagerOptions } from "./subagent-registry-run-wait.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import type { SubagentRegistrationScope, SubagentRunRecord } from "./subagent-registry.types.js";

function createWriteHold(phase: "before" | "ack") {
  const entered = createDeferred<void>();
  const gate = createDeferred<void>();
  let loseNativeReceipt = false;
  return {
    phase,
    entered: entered.promise,
    release: gate.resolve,
    reject: gate.reject,
    loseReceipt(error: unknown) {
      loseNativeReceipt = true;
      gate.reject(error);
    },
    async wait(admission?: SqliteWorkerOperationAdmission) {
      entered.resolve();
      try {
        await gate.promise;
      } catch (error) {
        // Drop the native receipt too, rather than simulating only a recoverable transport loss.
        if (loseNativeReceipt && admission) {
          Object.defineProperty(admission, "committed", { value: undefined });
        }
        throw error;
      }
    },
  };
}

function createQueuedRegistrationFixture(runs = new Map<string, SubagentRunRecord>()) {
  const pending: Promise<unknown>[] = [];
  const track = <T>(work: T | Promise<T>): Promise<T> => {
    const promise = Promise.resolve(work);
    pending.push(promise);
    void promise.catch(() => {});
    return promise;
  };
  const holds: ReturnType<typeof createWriteHold>[] = [];
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
                await hold.wait();
              }
              const receipt = await scope.execute(command, executeOptions);
              if (hold?.phase === "ack") {
                await hold.wait(admission);
              }
              return receipt;
            },
          }),
        {
          ...options,
          createAdmission:
            createAdmission &&
            ((nativeOperation) => {
              const prepared = createAdmission(nativeOperation);
              admission = prepared.admission;
              return prepared;
            }),
        },
      );
    });
  const options = {
    runs,
    getChildSessionCandidates: (key) =>
      [...runs.values()].filter((row) => row.childSessionKey === key),
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
  const registration: RegisterSubagentRunParams = createSubagentRunParams({
    runId: "queued-original",
    childSessionKey: "agent:main:subagent:synthetic",
    sessionEntry: { sessionId: "synthetic-session" },
    task: "synthetic queued work",
    retainAttachmentsOnKeep: true,
    collect: true,
    queued: true,
    queuedLaunch: {
      requesterRecovery: {},
      request: { sessionKey: "agent:main:subagent:synthetic" },
      timeoutMs: 100,
      schedulerGroupKey: "group",
      maxConcurrent: 1,
    },
  });
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
      assert(scope, "Queued intent has not published its scope");
      return scope;
    },
    current: () => {
      const row = runs.get(registration.runId);
      assert(row, "Queued row has not published");
      return row;
    },
    stored: () => loadSubagentRegistryFromSqlite().get(registration.runId),
    holdNextWrite: (phase: "before" | "ack" = "ack") => {
      const hold = createWriteHold(phase);
      holds.push(hold);
      allHolds.push(hold);
      return hold;
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
            assert(current, "Fixture row is absent");
            const draft = structuredClone(current);
            plan(draft);
            return { value: undefined, postimages: new Map([[draft.runId, draft]]) };
          },
          { runs },
        ),
      ),
    async close() {
      for (const hold of allHolds) {
        hold.release();
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
