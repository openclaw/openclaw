import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import {
  deleteDeliveryQueueEntryInDatabase,
  upsertDeliveryQueueEntryInDatabase,
} from "../../../infra/delivery-queue-sqlite.kernel.js";
import { getDeliveryQueueEntryStatus } from "../../../infra/delivery-queue-sqlite.test-support.js";
import {
  scheduleSessionDelivery,
  startSessionDeliveryRuntime,
} from "../../../infra/session-delivery-queue-runtime.js";
import { loadPendingSessionDelivery } from "../../../infra/session-delivery-queue-storage.js";
import {
  SESSION_DELIVERY_QUEUE_NAME as queueName,
  type QueuedSessionDelivery,
} from "../../../infra/session-delivery-queue.records.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../../test-utils/gateway-scheduler-clock.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { isSameSubagentRunOwner } from "../registry/subagent-run-generation.js";
import { useCompletionDatabase } from "./completion-database.test-support.js";
import { SubagentCompletionSourceChangedError } from "./subagent-completion-admission.store.js";
import {
  seedSubagentCompletionOwner,
  settleRequesterCompletionBatch,
} from "./subagent-completion-admission.test-helpers.js";
import type { RequesterWakeCommittedWrite } from "./subagent-completion-mutation.types.js";

const db = useCompletionDatabase("openclaw-requester-outcome-");

it.each(["pending", "completed", "replaced", "absent"] as const)(
  "joins the existing %s intent after a published callback fails",
  async (intentState) => {
    const entry = createSubagentRunRecord({
      runId: "blocked-requester-outcome",
      requesterAgentId: "main",
      createdAt: 1,
      execution: { status: "terminal", endedAt: 2, outcome: { status: "ok" } },
      expectsCompletionMessage: true,
      delivery: { status: "pending", generation: 1 },
      requesterSettleWake: {
        status: "pending",
        attemptCount: 0,
        rearmGeneration: 1,
        batchRunIds: ["blocked-requester-outcome"],
      },
    });
    seedSubagentCompletionOwner({ subagent: entry, databaseOptions: { database: db.value } });
    const queueContext = captureOpenClawStateWorkerContext();
    const clock = createGatewaySchedulerClock(Date.now());
    const scheduler = createTestGatewayScheduler(clock.clock);
    const deliver = vi.fn(async (_entry: QueuedSessionDelivery) => {});
    const onSettled = vi.fn();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const stop = startSessionDeliveryRuntime({ queueContext, scheduler, deliver, onSettled, log });
    let committed: RequesterWakeCommittedWrite | undefined;
    const settle = (onPublished: () => void) =>
      settleRequesterCompletionBatch({
        entries: [entry],
        outcome: { delivered: false, path: "none", error: "Requester unavailable" },
        context: queueContext,
        assertCurrent: () => {
          if (!isSameSubagentRunOwner(subagentRuns.get(entry.runId), entry)) {
            throw new SubagentCompletionSourceChangedError(
              "Subagent completion owner changed before settlement",
            );
          }
        },
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
      expect(committed?.result.queueIds).toHaveLength(1);
      const id = committed!.result.queueIds[0]!;
      const queued = await loadPendingSessionDelivery(id, queueContext);
      assert(queued?.kind === "systemEvent", "Blocked outcome must retain its system-event intent");
      expect(queued.text).toContain("Requester unavailable");
      expect(queued.text).toContain(entry.runId);
      expect(subagentRuns.get(entry.runId)?.requesterSettleWake).toBeUndefined();
      expect(deliver).not.toHaveBeenCalled();
      const advanceToIntent = () =>
        clock.advanceBy(Math.max(0, (queued.availableAt ?? queued.enqueuedAt) - scheduler.now()));
      if (intentState === "completed") {
        await scheduleSessionDelivery(id, queueContext);
        await advanceToIntent();
        expect(deliver).toHaveBeenCalledTimes(1);
        expect(getDeliveryQueueEntryStatus(queueName, id)).toBe("completed");
      } else if (intentState === "replaced") {
        const replacement: QueuedSessionDelivery = { ...queued, text: "Replacement intent" };
        upsertDeliveryQueueEntryInDatabase({ queueName, entry: replacement }, db.value);
      } else if (intentState === "absent") {
        deleteDeliveryQueueEntryInDatabase(db.value, queueName, id);
      }
      const triggers = [
        ["outcome_row_replay", "UPDATE", "subagent_runs"],
        ["outcome_queue_insert", "INSERT", "delivery_queue_entries"],
        ["outcome_queue_update", "UPDATE", "delivery_queue_entries"],
        ["outcome_queue_delete", "DELETE", "delivery_queue_entries"],
      ] as const;
      for (const [name, operation, table] of triggers) {
        db.value.db.exec(
          `CREATE TRIGGER ${name} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT, 'outcome replayed'); END`,
        );
      }
      try {
        const reconciliation = settle(() => {});
        if (intentState === "replaced" || intentState === "absent") {
          await expect(reconciliation).rejects.toThrow(/Requester outcome queue intent/);
        } else {
          expect(await reconciliation).toEqual({ applied: true, publication: "published" });
        }
      } finally {
        for (const [name] of triggers) {
          db.value.db.exec(`DROP TRIGGER ${name}`);
        }
      }
      await advanceToIntent();
      if (intentState === "pending" || intentState === "completed") {
        expect(deliver).toHaveBeenCalledTimes(1);
        expect(onSettled).toHaveBeenCalledOnce();
        expect(getDeliveryQueueEntryStatus(queueName, id)).toBe("completed");
        expect(await loadPendingSessionDelivery(id, queueContext)).toBeNull();
        expect(log.error).not.toHaveBeenCalled();
      } else {
        expect(deliver).not.toHaveBeenCalled();
        expect(onSettled).not.toHaveBeenCalled();
        expect((await loadPendingSessionDelivery(id, queueContext))?.kind).toBe(
          intentState === "absent" ? undefined : "systemEvent",
        );
      }
    } finally {
      await stop();
      await scheduler.stop();
    }
  },
);
