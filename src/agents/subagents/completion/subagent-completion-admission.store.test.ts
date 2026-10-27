import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  completeSessionDelivery,
  loadPendingSessionDeliveries,
  markSessionDeliverySettlement,
  moveSessionDeliveryToFailed,
} from "../../../infra/session-delivery-queue-storage.js";
import { prepareClaimedSessionDelivery } from "../../../infra/session-delivery-queue.records.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
import type { SqliteWorkerOperationAdmission } from "../../../infra/sqlite-worker-operation-admission.js";
import * as workerAdmission from "../../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../../infra/sqlite-worker-owner-probe.test-support.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import { forbidMainThreadSql } from "../../../test-utils/main-thread-sql-spies.test-support.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import {
  assertSubagentRegistryWriteOutcomeKnown,
  restoreSubagentRunsFromDisk,
} from "../registry/subagent-registry-persistence.js";
import { loadSubagentRegistryFromSqlite } from "../registry/subagent-registry-state.fixture.test-support.js";
import { readSubagentRun } from "../registry/subagent-registry.store.sqlite.js";
import {
  admitSubagentCompletionDelivery,
  settleSubagentCompletionDelivery,
} from "./subagent-completion-admission.store.js";
import {
  seedSubagentCompletionDelivery,
  seedSubagentCompletionOwner,
  withSubagentCompletionWorkerState,
  records as requesterRecords,
  currentCompletionRun,
  armRequesterWake,
  readCompletionSystemEvents,
  settleRequesterCompletionBatch,
  updateCompletionOwner,
} from "./subagent-completion-admission.test-helpers.js";
import {
  admitCorrelatedSubagentSessionDelivery,
  settleCorrelatedSubagentDelivery,
} from "./subagent-completion-delivery.js";
import type { RequesterWakeCommittedWrite } from "./subagent-completion-mutation.types.js";

function records() {
  const now = Date.now();
  const subagent = createSubagentRunRecord({
    runId: "completion-run",
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
      expectedMediaUrls: ["/tmp/completed-result.png"],
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

function setup(database: Parameters<Parameters<typeof withSubagentCompletionWorkerState>[0]>[0]) {
  const input = records();
  seedSubagentCompletionOwner({ subagent: input.expected, databaseOptions: { database } });
  const runId = input.expected.runId;
  const context = captureOpenClawStateWorkerContext();
  const admit = (assertCurrent = () => {}) =>
    admitSubagentCompletionDelivery({
      runId,
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
  return {
    input,
    database,
    context,
    admit,
    runId,
    owner: () => readSubagentRun(database, runId),
    pending: () => loadPendingSessionDeliveries(context),
  };
}

async function withAdmissionState(run: (fixture: ReturnType<typeof setup>) => Promise<void>) {
  await withSubagentCompletionWorkerState(async (database) => {
    await run(setup(database));
    expect(
      ["task_runs", "flow_runs"].map(
        (table) => database.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count,
      ),
    ).toEqual([0, 0]);
  });
}

function guardHostSql() {
  const sql = forbidMainThreadSql("Correlated completion touched main-thread SQLite");
  return { [Symbol.dispose]: () => sql.restore() };
}

afterEach(() => vi.restoreAllMocks());

describe("native subagent completion worker admission", () => {
  it.each(["pending", "acknowledged", "failed"] as const)(
    "preserves produced media completion until its %s receipt reconciles",
    async (receipt) => {
      await withAdmissionState(async ({ input, context, admit, owner, pending }) => {
        await admit();
        if (receipt === "acknowledged") {
          await markSessionDeliverySettlement(input.queueEntry, "recovered", context);
        }
        expect(owner()?.delivery).toMatchObject({
          status: "in_progress",
          queueId: input.queueEntry.id,
        });
        const [queued] = await pending();
        expect(queued?.id).toBe(input.queueEntry.id);
        const outcome = receipt === "failed" ? "moved-to-failed" : "recovered";
        if (receipt !== "acknowledged") {
          await markSessionDeliverySettlement(input.queueEntry, outcome, context);
        }
        await settleCorrelatedSubagentDelivery(
          expectDefined(queued, "pending receipt"),
          outcome,
          context,
        );
        if (receipt === "failed") {
          await moveSessionDeliveryToFailed(input.queueEntry.id, context);
        } else {
          await completeSessionDelivery(input.queueEntry.id, context);
        }
        expect(await pending()).toEqual([]);
        expect(owner()?.delivery).toMatchObject({
          status: receipt === "failed" ? "failed" : "delivered",
          disposition: receipt === "failed" ? "permanent_failure" : "delivered",
        });
      });
    },
  );

  it("keeps acknowledged legacy inference inert instead of settling its completion", async () => {
    await withAdmissionState(async ({ input, context, admit, owner, pending }) => {
      if (input.queueEntry.kind !== "agentTurn") {
        throw new Error("Expected the legacy inference fixture");
      }
      delete input.queueEntry.expectedMediaUrls;
      await admit();
      const before = owner();
      await markSessionDeliverySettlement(input.queueEntry, "recovered", context);
      const queued = expectDefined((await pending())[0], "legacy inference receipt");
      await settleCorrelatedSubagentDelivery(queued, "recovered", context);
      expect(owner()).toEqual(before);
      await expect(
        settleSubagentCompletionDelivery({
          subagent: expectDefined(subagentRuns.get(input.subagent.runId), "completion owner"),
          queueId: queued.id,
          context,
        }),
      ).rejects.toThrow("lost its produced delivery or native owner");
      expect(owner()).toEqual(before);
      expect(await pending()).toEqual([queued]);
    });
  });

  it("commits queue and native owner atomically, then acknowledges replay without rewriting them", async () => {
    await withAdmissionState(async ({ input, database, admit, owner, runId }) => {
      await updateCompletionOwner(runId, (current) => ({ ...current, label: "before admission" }));
      const result = await admit();
      expect(result).toMatchObject({
        claimed: true,
        status: "pending",
        subagent: { label: "before admission" },
      });
      expect(owner()?.delivery).toMatchObject({
        queueId: input.queueEntry.id,
        status: "in_progress",
        generation: 1,
      });
      const published = expectDefined(owner(), "native owner");
      expect(result.subagent).toEqual({ ...published, cleanupHandled: true });
      await expect(admit()).resolves.toMatchObject({
        claimed: false,
        status: "pending",
        subagent: { ...published, cleanupHandled: true },
      });
      expect(owner()).toEqual(published);
      expect(
        database.db.prepare("SELECT COUNT(*) AS count FROM delivery_queue_entries").get()?.count,
      ).toBe(1);
      const updateAcknowledged = vi.fn((current: typeof input.subagent) => ({
        ...current,
        label: "after replay",
      }));
      await updateCompletionOwner(runId, updateAcknowledged);
      expect(updateAcknowledged).toHaveBeenCalledOnce();
      expect(owner()).toMatchObject({
        label: "after replay",
        delivery: published.delivery,
        completion: published.completion,
      });
      expect(result.subagent).toEqual({ ...published, cleanupHandled: true });
    });
  });

  it.each([
    ["native write failure", /completion crash cut/],
    ["mismatched delivery generations", /one owner generation/],
    ["newer sibling identity", /completion owner (changed|was replaced)/],
    ["revoked transaction authority", /completion source retired/],
    ["revoked commit authority", /completion source retired/],
  ] as const)("leaves both owners unchanged after %s", async (cut, error) => {
    await withAdmissionState(async ({ input, database, admit, owner, pending }) => {
      let current = true;
      if (cut === "native write failure") {
        database.db.exec(
          "CREATE TRIGGER reject_completion AFTER UPDATE ON subagent_runs BEGIN SELECT RAISE(ABORT, 'completion crash cut'); END",
        );
      } else if (cut === "mismatched delivery generations") {
        input.subagent.delivery!.generation = 2;
      } else if (cut === "newer sibling identity") {
        seedSubagentCompletionDelivery({
          subagent: { ...structuredClone(input.expected), generation: 2, runId: "newer-run" },
          databaseOptions: { database },
        });
      } else {
        const stage = cut === "revoked transaction authority" ? "transaction" : "commit";
        probe.admission(workerAdmission, (request, grant, grantOwner) => {
          if (request.stage === stage) {
            current = false;
          }
          grantOwner(request, grant);
        });
      }
      const before = owner();
      await expect(
        admit(() => {
          if (!current) {
            throw new Error("completion source retired");
          }
        }),
      ).rejects.toThrow(error);
      expect(await pending()).toEqual([]);
      expect(owner()).toEqual(before);
    });
  });

  it("admits a raw-key completion independently of another agent's newer run", async () => {
    await withAdmissionState(async ({ input, database, admit, pending }) => {
      const { subagent, queueEntry, expected } = input;
      for (const entry of [subagent, expected]) {
        entry.childSessionKey = "global";
        entry.childAgentId = "main";
      }
      const other = {
        ...structuredClone(expected),
        runId: "other-agent-run",
        childAgentId: "other",
        generation: 2,
      };
      seedSubagentCompletionOwner({ subagent: expected, databaseOptions: { database } });
      seedSubagentCompletionOwner({ subagent: other, databaseOptions: { database } });
      const otherBefore = expectDefined(
        readSubagentRun(database, other.runId),
        "other agent's completion owner",
      );
      const result = await admit();
      expect(result).toMatchObject({ claimed: true, status: "pending" });
      expect((await pending()).map((entry) => entry.id)).toEqual([queueEntry.id]);
      expect(readSubagentRun(database, other.runId)).toEqual(otherBefore);
    });
  });

  it.each(["ordinary", "reply lost", "replacement", "metadata successor"] as const)(
    "publishes native completion before its admitted successor without host SQLite or record parsing (%s)",
    async (change) => {
      await withAdmissionState(async ({ input, context, owner, pending, runId }) => {
        let crossed = false;
        let successor: Promise<void> | undefined;
        probe.command(stateWorker, async (command, executeOptions, scope) => {
          const result = await scope.execute(command, executeOptions);
          if (command.type === "sessionDelivery.admitSubagentCompletion") {
            crossed = true;
            if (change === "replacement" || change === "metadata successor") {
              successor = updateCompletionOwner(
                runId,
                (current) => {
                  expect(current.delivery?.status).toBe("in_progress");
                  const next = structuredClone(current);
                  if (change === "replacement") {
                    next.generation = 2;
                    next.delivery = { status: "pending", generation: 2 };
                  } else {
                    next.task = "updated task";
                  }
                  return next;
                },
                { context },
              );
            } else if (change === "reply lost") {
              throw new Error("synthetic completion reply lost after commit");
            }
          }
          return result;
        });
        const parse = JSON.parse;
        const parsedRecords: string[] = [];
        let result: Awaited<ReturnType<typeof admitCorrelatedSubagentSessionDelivery>>;
        {
          using _ = guardHostSql();
          using clone = vi.spyOn(globalThis, "structuredClone");
          const beforeAdmission = expectDefined(subagentRuns.get(runId), "completion owner");
          const beforeDelivery = { ...beforeAdmission.delivery };
          const parser = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
            if (text.includes(input.expected.childSessionKey)) {
              parsedRecords.push(text);
            }
            return parse(text, reviver);
          });
          try {
            result = await admitCorrelatedSubagentSessionDelivery({
              runId,
              queueContext: context,
              payload: {
                kind: "agentTurn",
                sessionKey: input.expected.requesterSessionKey,
                message: "done",
                expectedMediaUrls: ["/tmp/completed-result.png"],
                messageId: "facade-completion",
              },
            });
            expect(crossed).toBe(true);
            expect(beforeAdmission.delivery).toEqual(beforeDelivery);
            await successor;
            expect.soft(clone.mock.calls.some(([value]) => value === beforeAdmission)).toBe(false);
            expect(parsedRecords).toEqual([]);
          } finally {
            parser.mockRestore();
          }
        }
        expect(result).toMatchObject({ claimed: true, status: "pending" });
        if (change === "replacement") {
          expect(subagentRuns.get(runId)).toMatchObject({
            generation: 2,
            delivery: { status: "pending", generation: 2 },
          });
          expect(owner()?.generation).toBe(2);
        } else {
          const delivery = { queueId: result.id, generation: 1 };
          expect(owner()?.delivery).toMatchObject(delivery);
          if (change === "metadata successor") {
            expect(subagentRuns.get(runId)?.task).toBe("updated task");
          }
          expect(subagentRuns.get(runId)?.delivery).toMatchObject({
            ...delivery,
            status: "in_progress",
          });
          const queued = expectDefined(
            (await pending()).find((entry) => entry.id === result.id),
            "committed correlated queue entry",
          );
          {
            using _ = guardHostSql();
            await markSessionDeliverySettlement(queued, "recovered", context);
            using clone = vi.spyOn(globalThis, "structuredClone");
            const beforeSettlement = expectDefined(subagentRuns.get(runId), "completion owner");
            const beforeDelivery = { ...beforeSettlement.delivery };
            await settleCorrelatedSubagentDelivery(queued, "recovered", context);
            expect(beforeSettlement.delivery).toEqual(beforeDelivery);
            expect.soft(clone.mock.calls.some(([value]) => value === beforeSettlement)).toBe(false);
          }
          expect(owner()?.delivery).toMatchObject({
            status: "delivered",
            generation: 1,
          });
          expect(subagentRuns.get(runId)?.delivery?.status).toBe("delivered");
          if (change === "metadata successor") {
            for (const entry of [owner(), subagentRuns.get(runId)]) {
              expect(entry?.task).toBe("updated task");
            }
          }
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
    using _ = probe.command(stateWorker, async (command, executeOptions, scope) => {
      const receipt = await scope.execute(command, executeOptions);
      if (command.type === "subagents.persistChanges" && !held) {
        held = true;
        acknowledged.resolve();
        await release.promise;
      }
      return receipt;
    });
    const completions = inputs.map(({ subagent }, index) =>
      updateCompletionOwner(subagent.runId, (current) => ({
        ...current,
        execution: {
          ...current.execution,
          status: "terminal",
          endedAt: Date.now(),
          outcome: { status: "ok" },
        },
        completion: {
          required: true,
          resultText: `child result ${index}`,
          capturedAt: Date.now(),
        },
      })),
    );
    const settled = settleRequesterCompletionBatch({
      entries: inputs.map(({ subagent }) => subagent),
      outcome: { delivered: true, path: "direct" },
      assertCurrent: () => {},
    });
    try {
      await Promise.race([acknowledged.promise, Promise.all(completions)]);
      expect(currentCompletionRun(inputs[0]!).execution.status).toBe("running");
      release.resolve();
      await Promise.all(completions);
      await expect(settled).resolves.toEqual({ applied: true, publication: "published" });
      await updateCompletionOwner(ids[0]!, (current) => ({
        ...current,
        label: "after batch settlement",
      }));
      const stored = loadSubagentRegistryFromSqlite();
      for (const [index, input] of inputs.entries()) {
        expect(currentCompletionRun(input)).toMatchObject({
          execution: { status: "terminal", outcome: { status: "ok" } },
          delivery: { status: "delivered" },
        });
        expect(currentCompletionRun(input).requesterSettleWake).toBeUndefined();
        expect(currentCompletionRun(input).completion?.resultText).toBeUndefined();
        expect(stored.get(input.subagent.runId)).toMatchObject({
          execution: { status: "terminal", outcome: { status: "ok" } },
          completion: { resultText: `child result ${index}` },
          delivery: { status: "delivered" },
          ...(index === 0 ? { label: "after batch settlement" } : {}),
        });
        expect(stored.get(input.subagent.runId)?.requesterSettleWake).toBeUndefined();
      }
    } finally {
      release.resolve();
      await Promise.allSettled([...completions, settled]);
    }
  });
});

it("retains a failed completion without creating another parent input after publication fails", async () => {
  await withSubagentCompletionWorkerState(async (database) => {
    const { subagent } = armRequesterWake(requesterRecords());
    seedSubagentCompletionOwner({ subagent, databaseOptions: { database } });
    let committed: RequesterWakeCommittedWrite | undefined;
    const settle = (onPublished: () => void) =>
      settleRequesterCompletionBatch({
        entries: [subagent],
        outcome: { delivered: false, path: "none", error: "Requester unavailable" },
        databaseOptions: { database },
        committed,
        onCommitted: (receipt) => {
          committed = receipt;
        },
        onPublished,
      });
    await expect(
      settle(() => {
        throw new Error("Synthetic publication observer failure");
      }),
    ).rejects.toMatchObject({ outcome: "committed", publication: "published" });
    expect(readCompletionSystemEvents(database)).toEqual([]);
    expect(subagentRuns.get(subagent.runId)?.delivery).toMatchObject({
      status: "failed",
      lastError: "Requester unavailable",
    });
    database.db.exec(
      "CREATE TRIGGER reject_replay BEFORE UPDATE ON subagent_runs BEGIN SELECT RAISE(ABORT, 'outcome replayed'); END",
    );
    await expect(settle(() => {})).resolves.toEqual({ applied: true, publication: "published" });
    expect(readCompletionSystemEvents(database)).toEqual([]);
  });
});

it("retains a committed wake with unreadable facts until canonical restore", async () => {
  await withSubagentCompletionWorkerState(async (database) => {
    const input = armRequesterWake(requesterRecords());
    seedSubagentCompletionOwner({ subagent: input.subagent, databaseOptions: { database } });
    const runWorker = stateWorker.runOpenClawStateWorkerOperation;
    let executions = 0;
    let corrupt = true;
    using _ = vi
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
    const context = captureOpenClawStateWorkerContext();
    const settle = () =>
      settleRequesterCompletionBatch({
        entries: [input.subagent],
        outcome: { delivered: true, path: "direct" },
        context,
      });
    const observedError: unknown = await settle().catch((error: unknown) => error);
    expect(executions).toBe(1);
    expect(corrupt).toBe(false);
    expect(loadSubagentRegistryFromSqlite().get(input.subagent.runId)?.delivery?.status).toBe(
      "delivered",
    );
    expect(observedError).toMatchObject({ outcome: "committed" });
    expect(hasSqliteWorkerOutcomeUnknown(observedError)).toBe(true);
    if (!(observedError instanceof Error)) {
      throw new Error("Expected the requester's retained write error");
    }
    expect(currentCompletionRun(input).requesterSettleWake).toBeDefined();
    await expect(settle()).rejects.toThrow(observedError);
    expect(executions).toBe(1);
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
  });
});
