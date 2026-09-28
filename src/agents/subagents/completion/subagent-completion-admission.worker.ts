import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import {
  bindDeliveryQueueEntry,
  loadDeliveryQueueEntryInDatabase,
  upsertBoundDeliveryQueueEntryInDatabase,
} from "../../../infra/delivery-queue-sqlite-bound.js";
import { getDeliveryQueueEntryOwnersInDatabase } from "../../../infra/delivery-queue-sqlite.kernel.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../../infra/kysely-sync.js";
import {
  SESSION_DELIVERY_QUEUE_NAME,
  type QueuedSessionDelivery,
} from "../../../infra/session-delivery-queue.records.js";
import type { SessionDeliveryWorkerOperations } from "../../../infra/session-delivery-queue.worker-contract.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../../../infra/sqlite-worker-operation-admission.js";
import { getSqliteWorkerStateContext } from "../../../infra/sqlite-worker-state-context.js";
import type { DB } from "../../../state/openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import {
  bindSubagentRunRecord,
  rowToSubagentRunRecord,
} from "../registry/subagent-registry.store.codec.js";
import { upsertSubagentRunRowInDatabase } from "../registry/subagent-registry.store.kernel.js";
import { compareSubagentRunGeneration } from "../registry/subagent-run-generation.js";
import { mutateSubagentCompletionInDatabase } from "./subagent-completion-mutation.kernel.js";

type Operation = SessionDeliveryWorkerOperations["sessionDelivery.admitSubagentCompletion"];
const query = (db: DatabaseSync) => getNodeSqliteKysely<Pick<DB, "subagent_runs">>(db);

/** The shared-state worker owns queue insertion and its exact native completion owner. */
export function admitSubagentCompletionInWorker(
  input: Operation["input"],
  database: OpenClawStateDatabase,
): Operation["output"] {
  const { expected, subagent, queueEntry, writeId } = input;
  const owner = queueEntry.kind === "agentTurn" ? queueEntry.owner : undefined;
  const delivery = subagent.delivery;
  if (
    !owner ||
    owner.kind !== "subagent_completion" ||
    owner.runId !== subagent.runId ||
    subagent.runId !== expected.runId ||
    owner.generation !== delivery?.generation ||
    owner.deadlineAt !== delivery.deadlineAt ||
    queueEntry.id !== delivery.queueId
  ) {
    throw new Error("subagent completion admission records do not share one owner generation");
  }
  const boundQueue = bindDeliveryQueueEntry({
    queueName: SESSION_DELIVERY_QUEUE_NAME,
    entry: queueEntry,
    insertOnly: true,
  });
  const expectedPayload = bindSubagentRunRecord(expected).payload_json;
  const boundSubagent = bindSubagentRunRecord(subagent);
  const readRow = () =>
    executeSqliteQuerySync(
      database.db,
      query(database.db)
        .selectFrom("subagent_runs")
        .selectAll()
        .where("run_id", "=", expected.runId),
    ).rows[0];
  return runOpenClawStateWriteTransaction(
    () => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: writeId });
      const originalRow = readRow();
      const current = originalRow && rowToSubagentRunRecord(originalRow);
      if (
        !current ||
        compareSubagentRunGeneration(current, expected) !== 0 ||
        current.childSessionKey !== expected.childSessionKey ||
        current.requesterSessionKey !== expected.requesterSessionKey ||
        current.requesterStorePath !== expected.requesterStorePath
      ) {
        throw new Error("subagent completion owner changed before admission");
      }
      const siblings = executeSqliteQuerySync(
        database.db,
        query(database.db)
          .selectFrom("subagent_runs")
          .selectAll()
          .where("child_session_key", "=", expected.childSessionKey),
      ).rows;
      for (const row of siblings) {
        const candidate = rowToSubagentRunRecord(row);
        if (!candidate || compareSubagentRunGeneration(candidate, expected) > 0) {
          throw new Error("subagent completion owner was replaced before admission");
        }
      }
      const claimed = upsertBoundDeliveryQueueEntryInDatabase(boundQueue, database);
      const status =
        getDeliveryQueueEntryOwnersInDatabase(
          database,
          [SESSION_DELIVERY_QUEUE_NAME],
          queueEntry.id,
        ).get(SESSION_DELIVERY_QUEUE_NAME)?.status ?? "pending";
      if (claimed) {
        if (bindSubagentRunRecord(current).payload_json !== expectedPayload) {
          throw new Error("subagent completion state changed before admission");
        }
        upsertSubagentRunRowInDatabase(database, boundSubagent);
      } else {
        // The namespace owns this payload; a duplicate may acknowledge only its original generation.
        const existing = loadDeliveryQueueEntryInDatabase(
          database,
          SESSION_DELIVERY_QUEUE_NAME,
          queueEntry.id,
          // SAFETY: The exact session queue namespace is written only with its typed delivery payload.
        ) as QueuedSessionDelivery | null;
        const existingOwner = existing?.kind === "agentTurn" ? existing.owner : undefined;
        if (
          !existingOwner ||
          existingOwner.kind !== owner.kind ||
          existingOwner.runId !== owner.runId ||
          existingOwner.taskId !== owner.taskId ||
          existingOwner.generation !== owner.generation ||
          existingOwner.deadlineAt !== owner.deadlineAt ||
          existing?.sessionKey !== queueEntry.sessionKey ||
          (existing.kind === "agentTurn" &&
            queueEntry.kind === "agentTurn" &&
            !isDeepStrictEqual(existing.requesterBinding, queueEntry.requesterBinding)) ||
          (current.delivery?.generation ?? 1) !== owner.generation ||
          (status === "pending" &&
            (current.delivery?.queueId !== queueEntry.id ||
              current.delivery.deadlineAt !== owner.deadlineAt))
        ) {
          throw new Error(`session delivery queue conflict for ${queueEntry.id}`);
        }
      }
      const row = readRow();
      if (!row) {
        throw new Error("subagent completion owner disappeared during admission");
      }
      const receipt = { writeId, claimed, status, row };
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: writeId });
      deferSqliteWorkerCommitReceipt(database.db, receipt);
      return receipt;
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    {
      operationLabel: "subagent completion delivery admission",
    },
  );
}

export function mutateSubagentCompletionInWorker(
  input: SessionDeliveryWorkerOperations["sessionDelivery.mutateSubagentCompletion"]["input"],
  database: OpenClawStateDatabase,
): SessionDeliveryWorkerOperations["sessionDelivery.mutateSubagentCompletion"]["output"] {
  return runOpenClawStateWriteTransaction(
    () => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: input.writeId });
      const receipt = {
        writeId: input.writeId,
        ...mutateSubagentCompletionInDatabase(database, input.mutation),
      };
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: input.writeId });
      deferSqliteWorkerCommitReceipt(database.db, receipt);
      return receipt;
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    {
      operationLabel: "subagent completion " + input.mutation.kind,
    },
  );
}
