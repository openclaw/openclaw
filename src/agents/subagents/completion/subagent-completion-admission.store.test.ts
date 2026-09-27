import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPendingSessionDeliveries } from "../../../infra/session-delivery-queue-storage.js";
import { prepareClaimedSessionDelivery } from "../../../infra/session-delivery-queue.records.js";
import * as workerAdmission from "../../../infra/sqlite-worker-operation-admission.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import { forbidMainThreadSql } from "../../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { readSubagentRun } from "../registry/subagent-registry.store.sqlite.js";
import { admitSubagentCompletionDelivery } from "./subagent-completion-admission.store.js";
import { seedSubagentCompletionDelivery } from "./subagent-completion-admission.test-helpers.js";
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
    admitSubagentCompletionDelivery({ ...input, context, assertCurrent });
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
        subagent: published,
      });
      expect(readSubagentRun(database, input.subagent.runId)).toEqual(published);
      expect(
        database.db.prepare("SELECT COUNT(*) AS count FROM delivery_queue_entries").get()?.count,
      ).toBe(1);
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

  it.each(["same run", "newer sibling"] as const)(
    "refuses a durable replacement with the %s identity",
    async (change) => {
      await withAdmissionState(async ({ input, database, context, admit }) => {
        const replacement = {
          ...structuredClone(input.expected),
          generation: 2,
          ...(change === "newer sibling" ? { runId: "newer-run" } : {}),
        };
        seedSubagentCompletionDelivery({ subagent: replacement, databaseOptions: { database } });
        const before = readSubagentRun(database, input.expected.runId);
        await expect(admit()).rejects.toThrow(/completion owner (changed|was replaced)/);
        expect(await loadPendingSessionDeliveries(context)).toEqual([]);
        expect(readSubagentRun(database, input.expected.runId)).toEqual(before);
      });
    },
  );

  it.each(["transaction", "commit"] as const)(
    "refuses revoked authority at worker %s admission",
    async (stage) => {
      await withAdmissionState(async ({ input, database, context, admit }) => {
        let current = true;
        const before = readSubagentRun(database, input.expected.runId);
        const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
        vi.spyOn(workerAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
          (grantOwner, attachment) =>
            createAdmission((request, grant) => {
              if (request.stage === stage) {
                current = false;
              }
              grantOwner(request, grant);
            }, attachment),
        );
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

  it.each(["ordinary", "reply lost", "replacement", "in-place change"] as const)(
    "publishes only its current facade owner without main-thread SQLite (%s)",
    async (change) => {
      await withAdmissionState(async ({ input, database, context }) => {
        const original = stateWorker.runOpenClawStateWorkerOperation;
        let crossed = false;
        let replacement = input.expected;
        vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockImplementation(
          (owner, operation, options) =>
            original(
              owner,
              (scope) =>
                operation({
                  execute: async (command, executeOptions) => {
                    const result = await scope.execute(command, executeOptions);
                    if (command.type === "sessionDelivery.admitSubagentCompletion") {
                      crossed = true;
                      if (change === "replacement") {
                        replacement = { ...structuredClone(input.expected), generation: 2 };
                        subagentRuns.set(replacement.runId, replacement);
                      } else if (change === "in-place change") {
                        input.expected.delivery = { status: "suspended", generation: 2 };
                      } else if (change === "reply lost") {
                        throw new Error("synthetic completion reply lost after commit");
                      }
                    }
                    return result;
                  },
                }),
              options,
            ),
        );
        const sql = forbidMainThreadSql("Correlated completion touched main-thread SQLite");
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
        } finally {
          sql.restore();
        }
        expect(result).toMatchObject({ claimed: true, status: "pending" });
        expect(readSubagentRun(database, input.expected.runId)?.delivery).toMatchObject({
          queueId: result.id,
          generation: 1,
        });
        if (change === "replacement") {
          expect(subagentRuns.get(input.expected.runId)).toBe(replacement);
          expect(replacement.generation).toBe(2);
          expect(replacement.delivery?.status).toBe("pending");
        } else if (change === "in-place change") {
          expect(input.expected.delivery).toEqual({ status: "suspended", generation: 2 });
        } else {
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
            await settleCorrelatedSubagentDelivery(queued, "recovered");
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
