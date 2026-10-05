import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { getDeliveryQueueEntryStatus } from "../../../infra/delivery-queue-sqlite.js";
import {
  deleteDeliveryQueueEntryInDatabase,
  upsertDeliveryQueueEntryInDatabase,
} from "../../../infra/delivery-queue-sqlite.kernel.js";
import {
  scheduleSessionDelivery,
  startSessionDeliveryRuntime,
} from "../../../infra/session-delivery-queue-runtime.js";
import { loadPendingSessionDelivery } from "../../../infra/session-delivery-queue-storage.js";
import {
  SESSION_DELIVERY_QUEUE_NAME,
  type QueuedSessionDelivery,
} from "../../../infra/session-delivery-queue.records.js";
import { resolvePreferredOpenClawTmpDir } from "../../../infra/tmp-openclaw-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../../test-utils/gateway-scheduler-clock.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { bindSubagentRunRecord } from "../registry/subagent-registry.store.codec.js";
import { writeSubagentRunValuesInDatabase } from "../registry/subagent-registry.store.kernel.js";
import { isSameSubagentRunOwner } from "../registry/subagent-run-generation.js";
import { settleRequesterCompletionBatch } from "./subagent-completion-admission.store.js";
import { admitCompletionFixtureDatabase } from "./subagent-completion-admission.test-helpers.js";
import type { RequesterWakeCommittedWrite } from "./subagent-completion-mutation.types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("committed requester outcome queue receipts", () => {
  let database: OpenClawStateDatabase;

  beforeEach(async () => {
    vi.stubEnv(
      "OPENCLAW_STATE_DIR",
      tempDirs.make("openclaw-requester-outcome-", resolvePreferredOpenClawTmpDir()),
    );
    database = openOpenClawStateDatabase();
    await admitCompletionFixtureDatabase();
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    subagentRuns.clear();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
  });

  it.each(["pending", "completed", "replaced", "absent"] as const)(
    "joins the existing %s intent after a published callback fails",
    async (intentState) => {
      const now = Date.now();
      const entry = createSubagentRunRecord({
        runId: "blocked-requester-outcome",
        childSessionKey: "agent:main:subagent:blocked-outcome",
        requesterSessionKey: "agent:main:requester-outcome",
        requesterAgentId: "main",
        createdAt: now - 20,
        endedAt: now - 10,
        outcome: { status: "ok" },
        expectsCompletionMessage: true,
        cleanupHandled: true,
        completion: { required: true, resultText: "Synthetic child result", capturedAt: now - 10 },
        delivery: { status: "pending", generation: 1 },
        requesterSettleWake: {
          status: "dispatching",
          attemptCount: 1,
          rearmGeneration: 1,
          batchRunIds: ["blocked-requester-outcome"],
        },
      });
      writeSubagentRunValuesInDatabase(database, [bindSubagentRunRecord(entry)], []);
      subagentRuns.set(entry.runId, entry);
      const context = captureOpenClawStateWorkerContext();
      const clock = createGatewaySchedulerClock(Date.now());
      const scheduler = createTestGatewayScheduler(clock.clock);
      const deliver = vi.fn(async (_entry: QueuedSessionDelivery) => {});
      const onSettled = vi.fn();
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const stop = startSessionDeliveryRuntime({
        queueContext: context,
        scheduler,
        deliver,
        onSettled,
        log,
      });
      let committed: RequesterWakeCommittedWrite | undefined;
      const settle = (onPublished: () => void) =>
        settleRequesterCompletionBatch({
          entries: [{ subagent: entry }],
          outcome: { delivered: false, path: "none", error: "Requester unavailable" },
          context,
          isCurrent: () => isSameSubagentRunOwner(subagentRuns.get(entry.runId), entry),
          committed,
          onCommitted: (receipt) => {
            committed = receipt;
          },
          onPublished,
        });
      try {
        await expect(
          settle(() => {
            throw new Error("Synthetic publication observer failure");
          }),
        ).rejects.toMatchObject({ outcome: "committed", publication: "published" });
        if (!committed || committed.result.queueIds.length !== 1) {
          throw new Error("Blocked outcome did not commit its queue intent");
        }
        const id = committed.result.queueIds[0]!;
        const queued = await loadPendingSessionDelivery(id, context);
        if (!queued || queued.kind !== "systemEvent") {
          throw new Error("Blocked outcome did not retain a system-event intent");
        }
        expect(queued.text).toContain("Requester unavailable");
        expect(subagentRuns.get(entry.runId)?.requesterSettleWake).toBeUndefined();
        expect(deliver).not.toHaveBeenCalled();
        const advanceToIntent = () =>
          clock.advanceBy(Math.max(0, (queued.availableAt ?? queued.enqueuedAt) - scheduler.now()));
        if (intentState === "completed") {
          await scheduleSessionDelivery(id, context);
          await advanceToIntent();
          expect(deliver).toHaveBeenCalledTimes(1);
          expect(getDeliveryQueueEntryStatus(SESSION_DELIVERY_QUEUE_NAME, id)).toBe("completed");
        } else if (intentState === "replaced") {
          const replacement: QueuedSessionDelivery = { ...queued, text: "Replacement intent" };
          upsertDeliveryQueueEntryInDatabase(
            { queueName: SESSION_DELIVERY_QUEUE_NAME, entry: replacement },
            database,
          );
        } else if (intentState === "absent") {
          deleteDeliveryQueueEntryInDatabase(database, SESSION_DELIVERY_QUEUE_NAME, id);
        }
        const triggers = [
          ["outcome_row_replay", "UPDATE", "subagent_runs"],
          ["outcome_queue_insert", "INSERT", "delivery_queue_entries"],
          ["outcome_queue_update", "UPDATE", "delivery_queue_entries"],
          ["outcome_queue_delete", "DELETE", "delivery_queue_entries"],
        ] as const;
        for (const [name, operation, table] of triggers) {
          database.db.exec(
            `CREATE TRIGGER ${name} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT, 'outcome replayed'); END`,
          );
        }
        try {
          const reconciliation = settle(() => {});
          if (intentState === "replaced" || intentState === "absent") {
            await expect(reconciliation).rejects.toThrow(/Requester outcome queue intent/);
          } else {
            await expect(reconciliation).resolves.toEqual({
              applied: true,
              publication: "published",
            });
          }
        } finally {
          for (const [name] of triggers) {
            database.db.exec(`DROP TRIGGER ${name}`);
          }
        }
        await advanceToIntent();
        if (intentState === "pending" || intentState === "completed") {
          expect(deliver).toHaveBeenCalledTimes(1);
          expect(onSettled).toHaveBeenCalledOnce();
          expect(getDeliveryQueueEntryStatus(SESSION_DELIVERY_QUEUE_NAME, id)).toBe("completed");
          expect(await loadPendingSessionDelivery(id, context)).toBeNull();
          expect(log.error).not.toHaveBeenCalled();
        } else {
          expect(deliver).not.toHaveBeenCalled();
          expect(onSettled).not.toHaveBeenCalled();
          expect((await loadPendingSessionDelivery(id, context))?.kind).toBe(
            intentState === "absent" ? undefined : "systemEvent",
          );
        }
      } finally {
        await stop();
        await scheduler.stop();
      }
    },
  );
});
