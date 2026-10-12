import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadPendingSessionDeliveries,
  markSessionDeliverySettlement,
} from "../../../infra/session-delivery-queue-storage.js";
import { prepareClaimedSessionDelivery } from "../../../infra/session-delivery-queue.records.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
import type { SqliteWorkerOperationAdmission } from "../../../infra/sqlite-worker-operation-admission.js";
import * as workerAdmission from "../../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../../infra/sqlite-worker-owner-probe.test-support.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import { forbidMainThreadSql } from "../../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import {
  assertSubagentRegistryWriteOutcomeKnown,
  mutateSubagentRuns,
  restoreSubagentRunsFromDisk,
} from "../registry/subagent-registry-persistence.js";
import { loadSubagentRegistryFromSqlite } from "../registry/subagent-registry-state.fixture.test-support.js";
import { readSubagentRun } from "../registry/subagent-registry.store.sqlite.js";
import { getSubagentRunRuntimeKey } from "../registry/subagent-run-generation.js";
import {
  admitSubagentCompletionDelivery,
  mutateRequesterCompletionBatch,
} from "./subagent-completion-admission.store.js";
import {
  seedSubagentCompletionDelivery,
  seedSubagentCompletionOwner,
  withSubagentCompletionWorkerState,
  records as requesterRecords,
  currentCompletionRun,
  armRequesterWake,
  requesterWakeDriver,
  advanceRequesterWakeTime,
} from "./subagent-completion-admission.test-helpers.js";
import {
  admitCorrelatedSubagentSessionDelivery,
  settleCorrelatedSubagentDelivery,
} from "./subagent-completion-delivery.js";

function records() {
  const now = Date.now();
  const subagent = createSubagentRunRecord({
    runId: "completion-run",
    childSessionKey: "agent:main:subagent:child",
    requesterSessionKey: "agent:main:main",
    requesterAgentId: "main",
    generation: 1,
    expectsCompletionMessage: true,
    endedAt: now,
    outcome: { status: "ok" },
    completion: { required: true, resultText: "canonical result", capturedAt: now },
    delivery: {
      status: "in_progress",
      disposition: "session_queued",
      generation: 1,
      queueId: "pending",
      deadlineAt: now + 60_000,
    },
  });
  const queueEntry = prepareClaimedSessionDelivery(
    {
      kind: "agentTurn",
      sessionKey: subagent.requesterSessionKey,
      message: "load native result at delivery time",
      messageId: "completion:1",
      idempotencyKey: "completion:1",
      owner: {
        kind: "subagent_completion",
        runId: subagent.runId,
        taskId: subagent.runId,
        generation: 1,
        deadlineAt: now + 60_000,
      },
    },
    125_000,
    now,
  );
  subagent.delivery!.queueId = queueEntry.id;
  const expected = structuredClone(subagent);
  expected.delivery = { status: "pending", generation: 1 };
  expected.cleanupHandled = true;
  return { subagent, queueEntry, expected };
}

async function withAdmissionState(
  run: (fixture: Awaited<ReturnType<typeof setup>>) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const fixture = await setup();
    try {
      await run(fixture);
      expect(
        fixture.database.db.prepare("SELECT COUNT(*) AS count FROM task_runs").get()?.count,
      ).toBe(0);
      expect(
        fixture.database.db.prepare("SELECT COUNT(*) AS count FROM flow_runs").get()?.count,
      ).toBe(0);
    } finally {
      vi.restoreAllMocks();
      subagentRuns.delete(fixture.input.expected.runId);
    }
  });
}
async function setup() {
  const input = records();
  const database = openOpenClawStateDatabase();
  seedSubagentCompletionDelivery({ subagent: input.expected, databaseOptions: { database } });
  subagentRuns.set(input.expected.runId, input.expected);
  const context = captureOpenClawStateWorkerContext();
  await loadPendingSessionDeliveries(context);
  const admit = (assertCurrent = () => {}) =>
    admitSubagentCompletionDelivery({
      runId: input.expected.runId,
      plan: (current) => ({
        queueEntry: input.queueEntry,
        subagent: {
          ...structuredClone(current),
          delivery: structuredClone(input.subagent.delivery),
        },
      }),
      context,
      assertCurrent,
    });
  return { input, database, context, admit };
}

afterEach(() => vi.restoreAllMocks());

describe("native subagent completion worker admission", () => {
  it("commits queue and native owner atomically, then acknowledges replay without rewriting them", async () => {
    await withAdmissionState(async ({ input, database, admit }) => {
      const result = await admit();
      expect(result).toMatchObject({ claimed: true, status: "pending" });
      expect(readSubagentRun(database, input.subagent.runId)?.delivery).toMatchObject({
        queueId: input.queueEntry.id,
        status: "in_progress",
        generation: 1,
      });
      const published = expectDefined(
        readSubagentRun(database, input.subagent.runId),
        "native owner",
      );
      await expect(admit()).resolves.toMatchObject({
        claimed: false,
        status: "pending",
        subagent: { ...published, cleanupHandled: true },
      });
      expect(readSubagentRun(database, input.subagent.runId)).toEqual(published);
      expect(
        database.db.prepare("SELECT COUNT(*) AS count FROM delivery_queue_entries").get()?.count,
      ).toBe(1);
      const updateAcknowledged = vi.fn((rows: ReadonlyMap<string, typeof input.subagent>) => ({
        value: undefined,
        postimages: new Map([
          [input.subagent.runId, { ...rows.get(input.subagent.runId)!, label: "after replay" }],
        ]),
      }));
      await mutateSubagentRuns([input.subagent.runId], updateAcknowledged);
      expect(updateAcknowledged).toHaveBeenCalledOnce();
    });
  });

  it.each(["queue", "subagent"] as const)(
    "rolls back both owners after a native failure at %s",
    async (phase) => {
      await withAdmissionState(async ({ input, database, context, admit }) => {
        const before = readSubagentRun(database, input.expected.runId);
        const target =
          phase === "queue" ? "INSERT ON delivery_queue_entries" : "UPDATE ON subagent_runs";
        database.db.exec(
          `CREATE TRIGGER reject_completion AFTER ${target} BEGIN SELECT RAISE(ABORT, 'completion crash cut'); END`,
        );
        await expect(admit()).rejects.toThrow("completion crash cut");
        expect(await loadPendingSessionDeliveries(context)).toEqual([]);
        expect(readSubagentRun(database, input.expected.runId)).toEqual(before);
      });
    },
  );

  it("refuses mismatched queue and native delivery generations before either write", async () => {
    await withAdmissionState(async ({ input, database, context, admit }) => {
      const before = readSubagentRun(database, input.expected.runId);
      input.subagent.delivery!.generation = 2;
      await expect(admit()).rejects.toThrow("one owner generation");
      expect(await loadPendingSessionDeliveries(context)).toEqual([]);
      expect(readSubagentRun(database, input.expected.runId)).toEqual(before);
    });
  });

  it("refuses a durable replacement with a newer sibling identity", async () => {
    await withAdmissionState(async ({ input, database, context, admit }) => {
      const replacement = {
        ...structuredClone(input.expected),
        generation: 2,
        runId: "newer-run",
      };
      seedSubagentCompletionDelivery({ subagent: replacement, databaseOptions: { database } });
      const before = readSubagentRun(database, input.expected.runId);
      await expect(admit()).rejects.toThrow(/completion owner (changed|was replaced)/);
      expect(await loadPendingSessionDeliveries(context)).toEqual([]);
      expect(readSubagentRun(database, input.expected.runId)).toEqual(before);
    });
  });

  it.each(["transaction", "commit"] as const)(
    "refuses revoked authority at worker %s admission",
    async (stage) => {
      await withAdmissionState(async ({ input, database, context, admit }) => {
        let current = true;
        const before = readSubagentRun(database, input.expected.runId);
        probe.admission(workerAdmission, (request, grant, grantOwner) => {
          if (request.stage === stage) {
            current = false;
          }
          grantOwner(request, grant);
        });
        await expect(
          admit(() => {
            if (!current) {
              throw new Error("completion source retired");
            }
          }),
        ).rejects.toThrow("completion source retired");
        expect(await loadPendingSessionDeliveries(context)).toEqual([]);
        expect(readSubagentRun(database, input.expected.runId)).toEqual(before);
      });
    },
  );

  it.each(["ordinary", "reply lost", "replacement", "metadata successor"] as const)(
    "publishes native completion before its admitted successor without host SQLite or record parsing (%s)",
    async (change) => {
      await withAdmissionState(async ({ input, database, context }) => {
        let crossed = false;
        let successor: Promise<void> | undefined;
        probe.command(stateWorker, async (command, executeOptions, scope) => {
          const result = await scope.execute(command, executeOptions);
          if (command.type === "sessionDelivery.admitSubagentCompletion") {
            crossed = true;
            if (change === "replacement" || change === "metadata successor") {
              successor = mutateSubagentRuns(
                [input.expected.runId],
                (rows) => {
                  const current = expectDefined(
                    rows.get(input.expected.runId),
                    "admitted successor predecessor",
                  );
                  expect(current.delivery?.status).toBe("in_progress");
                  const next = structuredClone(current);
                  if (change === "replacement") {
                    next.generation = 2;
                    next.delivery = { status: "pending", generation: 2 };
                  } else {
                    next.task = "metadata updated after completion admission";
                  }
                  return { value: undefined, postimages: new Map([[next.runId, next]]) };
                },
                { context },
              );
            } else if (change === "reply lost") {
              throw new Error("synthetic completion reply lost after commit");
            }
          }
          return result;
        });
        const sql = forbidMainThreadSql("Correlated completion touched main-thread SQLite");
        const parse = JSON.parse;
        const parsedRecords: string[] = [];
        const parser = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
          if (text.includes(input.expected.childSessionKey)) {
            parsedRecords.push(text);
          }
          return parse(text, reviver);
        });
        let result: Awaited<ReturnType<typeof admitCorrelatedSubagentSessionDelivery>>;
        try {
          result = await admitCorrelatedSubagentSessionDelivery({
            runId: input.expected.runId,
            queueContext: context,
            payload: {
              kind: "agentTurn",
              sessionKey: input.expected.requesterSessionKey,
              message: "done",
              messageId: "facade-completion",
            },
          });
          expect(crossed).toBe(true);
          await successor;
          expect(parsedRecords).toEqual([]);
        } finally {
          parser.mockRestore();
          sql.restore();
        }
        expect(result).toMatchObject({ claimed: true, status: "pending" });
        if (change === "replacement") {
          expect(subagentRuns.get(input.expected.runId)).toMatchObject({
            generation: 2,
            delivery: { status: "pending", generation: 2 },
          });
          expect(readSubagentRun(database, input.expected.runId)?.generation).toBe(2);
        } else {
          expect(readSubagentRun(database, input.expected.runId)?.delivery).toMatchObject({
            queueId: result.id,
            generation: 1,
          });
          if (change === "metadata successor") {
            expect(subagentRuns.get(input.expected.runId)?.task).toBe(
              "metadata updated after completion admission",
            );
          }
          expect(subagentRuns.get(input.expected.runId)?.delivery).toMatchObject({
            queueId: result.id,
            generation: 1,
            status: "in_progress",
          });
          const queued = expectDefined(
            (await loadPendingSessionDeliveries(context)).find((entry) => entry.id === result.id),
            "committed correlated queue entry",
          );
          const settlementSql = forbidMainThreadSql(
            "Correlated settlement touched main-thread SQLite",
          );
          try {
            await markSessionDeliverySettlement(queued, "recovered", context);
            await settleCorrelatedSubagentDelivery(queued, "recovered", context);
          } finally {
            settlementSql.restore();
          }
          expect(readSubagentRun(database, input.expected.runId)?.delivery).toMatchObject({
            status: "delivered",
            generation: 1,
          });
          expect(subagentRuns.get(input.expected.runId)?.delivery?.status).toBe("delivered");
        }
      });
    },
  );
});

it("settles a requester cohort after concurrently admitted children complete", async () => {
  await withSubagentCompletionWorkerState(async (database) => {
    const inputs = Array.from({ length: 4 }, (_, index) => {
      const input = requesterRecords();
      input.subagent.runId = `concurrent-child-${index}`;
      input.subagent.childSessionKey = `agent:main:subagent:concurrent-${index}`;
      input.subagent.execution = { status: "running", startedAt: Date.now() - 1_000 };
      input.subagent.completion = { required: true };
      return input;
    });
    const ids = inputs.map(({ subagent }) => subagent.runId);
    for (const input of inputs) {
      armRequesterWake(input, ids);
      seedSubagentCompletionOwner({ subagent: input.subagent, databaseOptions: { database } });
    }
    const acknowledged = createDeferredCore();
    const release = createDeferredCore();
    let held = false;
    const worker = probe.command(stateWorker, async (command, executeOptions, scope) => {
      const receipt = await scope.execute(command, executeOptions);
      if (command.type === "subagents.persistChanges" && !held) {
        held = true;
        acknowledged.resolve();
        await release.promise;
      }
      return receipt;
    });
    const completions = inputs.map(({ subagent }, index) =>
      mutateSubagentRuns([subagent.runId], (rows) => {
        const next = structuredClone(rows.get(subagent.runId)!);
        next.execution = {
          ...next.execution,
          status: "terminal",
          endedAt: Date.now(),
          outcome: { status: "ok" },
        };
        next.completion = {
          required: true,
          resultText: `child result ${index}`,
          capturedAt: Date.now(),
        };
        return { value: undefined, postimages: new Map([[next.runId, next]]) };
      }),
    );
    const settled = mutateRequesterCompletionBatch({
      entries: inputs.map(({ subagent }) => subagent),
      operation: { kind: "settle", outcome: { delivered: true, path: "direct" } },
      assertCurrent: () => {},
    });
    try {
      await Promise.race([acknowledged.promise, Promise.all(completions)]);
      expect(currentCompletionRun(inputs[0]!).execution.status).toBe("running");
      release.resolve();
      await Promise.all(completions);
      await expect(settled).resolves.toEqual({ applied: true, publication: "published" });
      const stored = loadSubagentRegistryFromSqlite();
      for (const [index, input] of inputs.entries()) {
        expect(currentCompletionRun(input)).toMatchObject({
          execution: { status: "terminal", outcome: { status: "ok" } },
          completion: { resultText: `child result ${index}` },
          delivery: { status: "delivered" },
        });
        expect(currentCompletionRun(input).requesterSettleWake).toBeUndefined();
        expect(stored.get(input.subagent.runId)?.delivery?.status).toBe("delivered");
        expect(stored.get(input.subagent.runId)?.requesterSettleWake).toBeUndefined();
      }
    } finally {
      release.resolve();
      await Promise.allSettled([...completions, settled]);
      worker.mockRestore();
    }
  });
});

it("retains a committed wake with unreadable facts until canonical restore", async () => {
  await withSubagentCompletionWorkerState(async (database) => {
    const input = armRequesterWake(requesterRecords());
    seedSubagentCompletionOwner({ subagent: input.subagent, databaseOptions: { database } });
    const driver = requesterWakeDriver([input]);
    const runWorker = stateWorker.runOpenClawStateWorkerOperation;
    let executions = 0;
    let corrupt = true;
    let firstEpisode: ReturnType<typeof driver.controller.pendingRequesterSettleWakeCommits.get>;
    let observedError: unknown;
    const worker = vi
      .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
      .mockImplementation((context, operation, options) => {
        let admission: SqliteWorkerOperationAdmission | undefined;
        const createAdmission = options?.createAdmission;
        return runWorker(
          context,
          (scope) =>
            operation({
              execute: async (command, executeOptions) => {
                if (command.type === "sessionDelivery.mutateSubagentCompletion") {
                  executions += 1;
                  firstEpisode ??= driver.controller.pendingRequesterSettleWakeCommits.get(
                    getSubagentRunRuntimeKey(input.subagent),
                  );
                }
                const result = await scope.execute(command, executeOptions);
                if (command.type === "sessionDelivery.mutateSubagentCompletion" && corrupt) {
                  corrupt = false;
                  admission?.service();
                  if (!admission?.committed) {
                    throw new Error("Expected the executing owner's native commit receipt");
                  }
                  Object.defineProperty(admission, "committed", { value: { facts: undefined } });
                  throw new Error("Synthetic result transport failure after native commit");
                }
                return result;
              },
            }),
          {
            ...options,
            createAdmission: createAdmission
              ? (operationAdmission) => {
                  const created = createAdmission(operationAdmission);
                  admission = created.admission;
                  return created;
                }
              : undefined,
          },
        );
      });
    driver.wake.mockImplementation(async (params) => {
      try {
        await params.transitionBatch(
          [input.subagent],
          { status: "dispatching", attemptCount: 1, rearmGeneration: 1 },
          () => {},
        );
      } catch (error) {
        observedError = error;
        throw error;
      }
      return false;
    });
    vi.useFakeTimers({ toNotFake: ["hrtime", "performance"] });
    const context = captureOpenClawStateWorkerContext();
    try {
      await driver.run();
      expect(executions).toBe(1);
      expect(corrupt).toBe(false);
      expect(
        loadSubagentRegistryFromSqlite().get(input.subagent.runId)?.requesterSettleWake?.status,
      ).toBe("dispatching");
      expect(observedError).toMatchObject({ outcome: "committed" });
      expect(hasSqliteWorkerOutcomeUnknown(observedError)).toBe(true);
      if (!(observedError instanceof Error)) {
        throw new Error("Expected the requester wake's retained write error");
      }
      expect(firstEpisode).toBeDefined();
      expect(
        driver.controller.pendingRequesterSettleWakeCommits.get(
          getSubagentRunRuntimeKey(input.subagent),
        ),
      ).toBe(firstEpisode);
      expect(currentCompletionRun(input).requesterSettleWake?.status).toBe("pending");
      await advanceRequesterWakeTime(30_000);
      expect(executions).toBe(1);
      expect(
        driver.controller.pendingRequesterSettleWakeCommits.get(
          getSubagentRunRuntimeKey(input.subagent),
        ),
      ).toBe(firstEpisode);
      driver.controller.clearScheduledResumeTimers();
      await closeOpenClawStateDatabaseAsync();
      expect(() =>
        assertSubagentRegistryWriteOutcomeKnown([input.subagent.runId], context.admission),
      ).toThrow(observedError);
      await restoreSubagentRunsFromDisk({ runs: subagentRuns });
      expect(() =>
        assertSubagentRegistryWriteOutcomeKnown(
          [input.subagent.runId],
          captureOpenClawStateWorkerContext().admission,
        ),
      ).not.toThrow();
      expect(subagentRuns.get(input.subagent.runId)).not.toBe(input.subagent);
      expect(executions).toBe(1);
    } finally {
      driver.controller.clearScheduledResumeTimers();
      worker.mockRestore();
      vi.useRealTimers();
    }
  });
});
