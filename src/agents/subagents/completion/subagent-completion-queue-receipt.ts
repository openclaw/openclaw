import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../../infra/kysely-sync.js";
import { SESSION_DELIVERY_QUEUE_NAME } from "../../../infra/session-delivery-queue.records.js";
import type { OpenClawStateDatabase } from "../../../state/openclaw-state-db-contract.js";
import type { DB } from "../../../state/openclaw-state-db.generated.js";
import type { SubagentCompletionQueueReceipt } from "./subagent-completion-mutation.types.js";

/** Read an existing intent without invoking queue admission's receipt-pruning writes. */
export function readSubagentCompletionQueueReceipt(
  database: OpenClawStateDatabase,
  id: string,
): SubagentCompletionQueueReceipt {
  const row = executeSqliteQuerySync(
    database.db,
    getNodeSqliteKysely<Pick<DB, "delivery_queue_entries">>(database.db)
      .selectFrom("delivery_queue_entries")
      .select(["status", "entry_json", "enqueued_at"])
      .where("queue_name", "=", SESSION_DELIVERY_QUEUE_NAME)
      .where("id", "=", id),
  ).rows[0];
  if (!row) {
    // Retention may remove a terminal intent, but absence cannot establish its outcome.
    throw new Error("Requester outcome queue intent is unavailable for reconciliation");
  }
  if (row.status === "completed" || row.status === "failed") {
    return { id, status: row.status };
  }
  const payload: unknown = JSON.parse(row.entry_json);
  if (row.status !== "pending" || !isRecord(payload) || payload.kind !== "systemEvent") {
    throw new Error("Requester outcome queue intent has another owner");
  }
  return {
    id,
    status: "pending",
    enqueuedAt: row.enqueued_at,
    // Retry leases and transport acknowledgements belong to the queue owner; the
    // system-event payload and initial enqueue time identify this pending intent.
    payloadJson: JSON.stringify({
      kind: payload.kind,
      sessionKey: payload.sessionKey,
      agentId: payload.agentId,
      text: payload.text,
      deliveryContext: payload.deliveryContext,
      idempotencyKey: payload.idempotencyKey,
      maxRetries: payload.maxRetries,
      completionRetention: payload.completionRetention,
    }),
  };
}

export function reconcileSubagentCompletionQueueReceipts(
  database: OpenClawStateDatabase,
  ids: readonly string[],
  receipts: readonly SubagentCompletionQueueReceipt[] | undefined,
): SubagentCompletionQueueReceipt[] {
  if (!receipts || receipts.length !== ids.length || new Set(ids).size !== ids.length) {
    throw new Error("Requester outcome lost its committed queue receipts");
  }
  return ids.map((id) => {
    const previous = receipts.find((receipt) => receipt.id === id);
    const current = readSubagentCompletionQueueReceipt(database, id);
    if (!previous || (current.status === "pending" && !isDeepStrictEqual(current, previous))) {
      throw new Error("Requester outcome queue intent was replaced");
    }
    return current;
  });
}
