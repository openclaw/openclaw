import { AsyncLocalStorage } from "node:async_hooks";
import { onTestFinished, vi } from "vitest";
import type { SqliteWorkerCommand } from "../../../infra/sqlite-worker-contract.js";
import type { OpenClawStateWorkerOperations } from "../../../state/openclaw-state-worker-contract.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import {
  SubagentLifecycleController,
  type SubagentLifecycleOptions,
} from "./subagent-registry-lifecycle.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import { getLatestSubagentRunByChildSessionKeyFromRuns } from "./subagent-registry-queries.js";
import { rowToSubagentRunRecord } from "./subagent-registry.store.codec.js";
import { subagentRunRowVersion } from "./subagent-registry.store.row.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import {
  getSubagentRunRuntimeKey,
  copySubagentRunRuntimeOwner,
} from "./subagent-run-generation.js";

export type RunEntryOverrides = Omit<Partial<SubagentRunRecord>, "execution"> & {
  execution?: SubagentRunRecord["execution"];
  startedAt?: number;
  endedAt?: number;
  outcome?: SubagentRunRecord["execution"]["outcome"];
};

export function createRunEntry(overrides: RunEntryOverrides = {}): SubagentRunRecord {
  const { startedAt = 2_000, endedAt, outcome, execution, ...recordOverrides } = overrides;
  return createSubagentRunRecord({
    runId: "run-1",
    childSessionKey: "agent:main:subagent:child",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "finish the task",
    cleanup: "keep",
    createdAt: 1_000,
    ...recordOverrides,
    execution: execution
      ? { startedAt, ...execution }
      : {
          status: endedAt !== undefined || outcome !== undefined ? "terminal" : "running",
          startedAt,
          ...(endedAt === undefined ? {} : { endedAt }),
          ...(outcome === undefined ? {} : { outcome }),
        },
  });
}

type RequesterSettleWakeParams = Parameters<
  SubagentLifecycleOptions["maybeWakeRequesterAfterAllChildrenSettled"]
>[0];

export type LifecycleFixtureWrite = {
  runIds: readonly string[];
  postimages: ReadonlyMap<string, SubagentRunRecord | null>;
};
export type LifecycleControllerFixtureOptions = {
  entry: SubagentRunRecord;
  runs?: Map<string, SubagentRunRecord>;
  beforeWrite?: (write: LifecycleFixtureWrite) => void | Promise<void>;
  realWorker?: boolean;
} & Partial<SubagentLifecycleOptions>;

type FixtureOwner = {
  runs: Map<string, SubagentRunRecord>;
  beforeWrite?: LifecycleControllerFixtureOptions["beforeWrite"];
  realWorker?: boolean;
};
const fixtureOwners = new WeakMap<SubagentRunRecord, FixtureOwner>();
const fixtureScope = new AsyncLocalStorage<FixtureOwner>();
let workerStubInstalled = false;

function installPolicyWorkerStub(fallbackOwner?: FixtureOwner) {
  if (workerStubInstalled) {
    return;
  }
  workerStubInstalled = true;
  const original = stateWorker.runOpenClawStateWorkerOperation;
  const spy = vi
    .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
    .mockImplementation(async (context, operation, options) => {
      const owner = fixtureScope.getStore() ?? fallbackOwner;
      if (!owner || owner.realWorker) {
        return original(context, operation, options);
      }
      context.admission.assertCurrent();
      options?.assertCurrent?.();
      return operation({
        // Controller policy cases exercise the real row owner with a transport ACK.
        // Native FIFO/CAS/event authority belongs to the registered worker suites.
        execute: vi
          .fn()
          .mockImplementation(
            async (command: SqliteWorkerCommand<OpenClawStateWorkerOperations>) => {
              if (command.type !== "subagents.persistChanges") {
                return original(context, (scope) => scope.execute(command), options);
              }
              const write = command.input;
              const values = write.values.map((row) => {
                if (typeof row.payload_json !== "string") {
                  throw new Error("Lifecycle worker write lacks encoded row");
                }
                return {
                  ...row,
                  controller_session_key: row.controller_session_key ?? null,
                  requester_store_path: row.requester_store_path ?? null,
                  controller_store_path: row.controller_store_path ?? null,
                  payload_json: row.payload_json,
                };
              });
              const postimages = new Map<string, SubagentRunRecord | null>(
                values.map((row) => [row.run_id, rowToSubagentRunRecord(row)]),
              );
              for (const id of write.deleteRunIds) {
                postimages.set(id, null);
              }
              if (postimages.size > 0) {
                await owner.beforeWrite?.({ runIds: [...postimages.keys()], postimages });
              }
              options?.assertCurrent?.();
              return {
                writeId: write.writeId,
                versions: new Map([
                  ...values.map((row) => [row.run_id, subagentRunRowVersion(row)] as const),
                  ...write.deleteRunIds.map((id) => [id, null] as const),
                ]),
                notices: [],
              };
            },
          ),
      });
    });
  onTestFinished(() => {
    spy.mockRestore();
    workerStubInstalled = false;
  });
}

/** A single-owner policy harness may run callbacks through fake timers without caller ALS. */
export function installLifecycleWorkerAckFixture(runs: Map<string, SubagentRunRecord>): void {
  installPolicyWorkerStub({ runs });
}

export function readLifecycleRun(entry: SubagentRunRecord): SubagentRunRecord {
  const owner = fixtureOwners.get(entry);
  if (!owner) {
    throw new Error("Lifecycle fixture entry has no controller owner");
  }
  const current = owner.runs.get(entry.runId);
  if (!current) {
    throw new Error("Lifecycle fixture execution was retired");
  }
  fixtureOwners.set(current, owner);
  return current;
}

export function mutateLifecycleRun(
  entry: SubagentRunRecord,
  mutate: (draft: SubagentRunRecord) => void,
): Promise<void> {
  const owner = fixtureOwners.get(entry);
  if (!owner) {
    throw new Error("Lifecycle fixture entry has no controller owner");
  }
  return fixtureScope.run(owner, () =>
    mutateSubagentRuns(
      [entry.runId],
      (rows) => {
        const current = rows.get(entry.runId);
        if (!current) {
          throw new Error("Lifecycle fixture execution was retired");
        }
        const draft = structuredClone(current);
        mutate(draft);
        return { value: undefined, postimages: new Map([[draft.runId, draft]]) };
      },
      { runs: owner.runs },
    ),
  );
}

export function createLifecycleControllerFixture(
  {
    entry,
    runs = new Map([[entry.runId, entry]]),
    beforeWrite,
    realWorker,
    ...overrides
  }: LifecycleControllerFixtureOptions,
  dependencies: Pick<
    SubagentLifecycleOptions,
    "callGateway" | "cleanupBrowserSessionsForLifecycleEnd"
  > & {
    ownersByEntry: Map<object, Pick<SubagentLifecycleOptions, "runs">>;
  },
) {
  const initialRows = [...runs.values()];
  for (const row of initialRows) {
    if (row.completion && row.delivery) {
      continue;
    }
    runs.set(
      row.runId,
      copySubagentRunRuntimeOwner(
        row,
        createSubagentRunRecord({
          ...row,
          completion: row.completion ?? { required: row.expectsCompletionMessage === true },
          delivery: row.delivery ?? {
            status: row.expectsCompletionMessage === false ? "not_required" : "pending",
          },
        }),
      ),
    );
  }
  const params: SubagentLifecycleOptions = {
    runs,
    resumedRuns: new Set(),
    subagentAnnounceTimeoutMs: 1_000,
    getRuntimeConfig: () => ({}),
    clearPendingLifecycleError: vi.fn(),
    countPendingDescendantRuns: async () => 0,
    getLatestRunForChildSession: (key, matches) =>
      getLatestSubagentRunByChildSessionKeyFromRuns(runs, key, matches) ?? null,
    suppressAnnounceForSteerRestart: () => false,
    shouldEmitEndedHookForRun: () => false,
    emitSubagentEndedHookForRun: vi.fn(async () => {}),
    emitSubagentProgressEndedForRun: vi.fn(async () => {}),
    notifyContextEngineSubagentEnded: vi.fn(async () => {}),
    retireSupersededRun: vi.fn(async () => {}),
    resumeSubagentRun: vi.fn(),
    callGateway: dependencies.callGateway,
    captureSubagentCompletionReply: vi.fn(async () => "final completion reply"),
    cleanupBrowserSessionsForLifecycleEnd: dependencies.cleanupBrowserSessionsForLifecycleEnd,
    runSubagentAnnounceFlow: vi.fn(async () => "delivered" as const),
    maybeWakeRequesterAfterAllChildrenSettled: vi.fn(
      async (wakeParams: {
        settledEntry: SubagentRunRecord;
        completeBatch: RequesterSettleWakeParams["completeBatch"];
      }) => {
        await wakeParams.completeBatch([wakeParams.settledEntry]);
        return false;
      },
    ),
    warn: vi.fn(),
  };
  Object.assign(params, overrides);
  installPolicyWorkerStub();
  const owner: FixtureOwner = { runs, beforeWrite, realWorker };
  fixtureOwners.set(entry, owner);
  for (const row of initialRows) {
    fixtureOwners.set(row, owner);
  }
  const recordOwners = () => {
    for (const run of params.runs.values()) {
      dependencies.ownersByEntry.set(getSubagentRunRuntimeKey(run), params);
      fixtureOwners.set(run, owner);
    }
  };
  recordOwners();
  const runOwned =
    <Args extends unknown[], Result>(operation: (...args: Args) => Result) =>
    (...args: Args): Result =>
      fixtureScope.run(owner, () => {
        recordOwners();
        return operation(...args);
      });
  const wake = params.maybeWakeRequesterAfterAllChildrenSettled;
  params.maybeWakeRequesterAfterAllChildrenSettled = (request) => {
    recordOwners();
    return fixtureScope.run(owner, () =>
      wake({
        ...request,
        transitionBatch: runOwned(request.transitionBatch),
        completeBatch: runOwned(request.completeBatch),
      }),
    );
  };
  const controller = new SubagentLifecycleController(params);
  controller.completeSubagentRun = runOwned(controller.completeSubagentRun);
  controller.startSubagentAnnounceCleanupFlow = runOwned(
    controller.startSubagentAnnounceCleanupFlow,
  );
  controller.completeCleanupBookkeeping = runOwned(controller.completeCleanupBookkeeping);
  controller.refreshFrozenResultFromSession = runOwned(controller.refreshFrozenResultFromSession);
  controller.finalizeResumedAnnounceGiveUp = runOwned(controller.finalizeResumedAnnounceGiveUp);
  controller.markRequesterTurnYielded = runOwned(controller.markRequesterTurnYielded);
  controller.settleRequesterTurnAfterSessionSpawns = runOwned(
    controller.settleRequesterTurnAfterSessionSpawns,
  );
  controller.cancelRequesterSettleWake = runOwned(controller.cancelRequesterSettleWake);
  controller.resumeAncestorCleanup = runOwned(controller.resumeAncestorCleanup);
  controller.resumeRequesterSettleWake = runOwned(controller.resumeRequesterSettleWake);
  controller.runRequesterSettleWake = runOwned(controller.runRequesterSettleWake);
  controller.revokeTerminalSessionEffects = runOwned(
    controller.revokeTerminalSessionEffects.bind(controller),
  );
  onTestFinished(() => controller.clearScheduledResumeTimers());
  return controller;
}
