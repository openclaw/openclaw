import { randomBytes } from "node:crypto";
import {
  bindDeliveryQueueEntry,
  loadDeliveryQueueEntryInDatabase,
  upsertBoundDeliveryQueueEntryInDatabase,
} from "../infra/delivery-queue-sqlite-bound.js";
import { getDeliveryQueueEntryOwnersInDatabase } from "../infra/delivery-queue-sqlite.kernel.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { NATIVE_CHILD_DELIVERY_QUEUE_NAME } from "../infra/session-delivery-queue.records.js";
import type { OpenClawPluginAsyncToolCallbackStatus } from "../plugins/tool-types.js";
import { isIncognitoSessionKey } from "../shared/incognito-session-key.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  preparePluginCallbackExpiry,
  preparePluginCallbackResult,
} from "./plugin-async-callback-payload.js";
import {
  type PluginAsyncCallbackBinding,
  assertPluginAsyncCallbackCapacity,
  hashPluginAsyncCallbackToken as digest,
  pluginAsyncCallbackSlot,
  validatePluginAsyncCallbackDeadline,
  PLUGIN_CALLBACK_MAX_RESULT_CHARS,
  PLUGIN_CALLBACK_RECEIPT_RETENTION_MS,
} from "./plugin-async-callback-policy.js";

// One host-owned row is the capability ledger; the session queue is its atomic outbox.
// Never persist or log the bearer secret. A queued turn targets only the recorded child.
const LEDGER_PLUGIN_ID = "core:plugin-async-callback";
const LEDGER_NAMESPACE = "async-tool-callback";
const ACTIVE_NAMESPACE = "async-tool-callback.active";

type PendingCallback = PluginAsyncCallbackBinding & {
  status: "pending" | "completed" | "cancelled" | "expired";
  expiresAt: number;
  queueId?: string;
  deliveryStatus?: "delivered" | "failed";
};

function ledger(database: OpenClawStateDatabase) {
  return getNodeSqliteKysely<Pick<DB, "plugin_state_entries">>(database.db);
}

function pluginActiveNamespace(pluginId: string): string {
  return ACTIVE_NAMESPACE + "." + digest(pluginId);
}

function countCallbackSlots(database: OpenClawStateDatabase, namespace: string): number {
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    ledger(database)
      .selectFrom("plugin_state_entries")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("plugin_id", "=", LEDGER_PLUGIN_ID)
      .where("namespace", "=", namespace),
  );
  return row?.count ?? 0;
}

/** These reservations share the ledger/outbox transaction and survive until its owner settles. */
function reserveCallbackSlot(
  database: OpenClawStateDatabase,
  binding: PluginAsyncCallbackBinding,
  key: string,
  now: number,
): void {
  const slot = pluginAsyncCallbackSlot(binding);
  const pluginNamespace = pluginActiveNamespace(binding.pluginId);
  const occupied = executeSqliteQueryTakeFirstSync(
    database.db,
    ledger(database)
      .selectFrom("plugin_state_entries")
      .select("entry_key")
      .where("plugin_id", "=", LEDGER_PLUGIN_ID)
      .where("namespace", "=", ACTIVE_NAMESPACE)
      .where("entry_key", "=", slot),
  );
  assertPluginAsyncCallbackCapacity({
    occupied: occupied !== undefined,
    pluginPending: countCallbackSlots(database, pluginNamespace),
    totalPending: countCallbackSlots(database, ACTIVE_NAMESPACE),
  });
  executeSqliteQuerySync(
    database.db,
    ledger(database)
      .insertInto("plugin_state_entries")
      .values([
        {
          plugin_id: LEDGER_PLUGIN_ID,
          namespace: ACTIVE_NAMESPACE,
          entry_key: slot,
          value_json: JSON.stringify([key, binding.pluginId]),
          created_at: now,
          // Queue settlement owns removal; GC must not free an admitted continuation slot.
          expires_at: null,
        },
        {
          plugin_id: LEDGER_PLUGIN_ID,
          namespace: pluginNamespace,
          entry_key: slot,
          value_json: JSON.stringify(key),
          created_at: now,
          expires_at: null,
        },
      ]),
  );
}

function releaseCallbackSlot(
  database: OpenClawStateDatabase,
  binding: PluginAsyncCallbackBinding,
  key: string,
): void {
  const slot = pluginAsyncCallbackSlot(binding);
  for (const [namespace, value] of [
    [ACTIVE_NAMESPACE, JSON.stringify([key, binding.pluginId])],
    [pluginActiveNamespace(binding.pluginId), JSON.stringify(key)],
  ] as const) {
    executeSqliteQuerySync(
      database.db,
      ledger(database)
        .deleteFrom("plugin_state_entries")
        .where("plugin_id", "=", LEDGER_PLUGIN_ID)
        .where("namespace", "=", namespace)
        .where("entry_key", "=", slot)
        .where("value_json", "=", value),
    );
  }
}

function readCallback(database: OpenClawStateDatabase, key: string): PendingCallback | undefined {
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    ledger(database)
      .selectFrom("plugin_state_entries")
      .select("value_json")
      .where("plugin_id", "=", LEDGER_PLUGIN_ID)
      .where("namespace", "=", LEDGER_NAMESPACE)
      .where("entry_key", "=", key),
  );
  // SAFETY: only host issue/completion/cancellation/expiry writes this namespace; plugins cannot supply its JSON.
  return row ? (JSON.parse(row.value_json) as PendingCallback) : undefined;
}

/** Internal host lookup only; never expose the stored child binding to a plugin. */
export function findPluginAsyncCallbackInDatabase(
  database: OpenClawStateDatabase,
  token: string,
): (PluginAsyncCallbackBinding & { status: PendingCallback["status"] }) | undefined {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    return undefined;
  }
  const row = readCallback(database, digest(token));
  return row
    ? {
        status: row.status,
        pluginId: row.pluginId,
        toolName: row.toolName,
        childSessionKey: row.childSessionKey,
        childSessionId: row.childSessionId,
        childRunId: row.childRunId,
        childGeneration: row.childGeneration,
        childCreatedAt: row.childCreatedAt,
      }
    : undefined;
}

/** Must be invoked inside the shared-state worker's admitted synchronous write transaction. */
export function issuePluginAsyncCallbackInDatabase(
  database: OpenClawStateDatabase,
  binding: PluginAsyncCallbackBinding,
  ttlMs: number,
  now = Date.now(),
): { token: string; expiresAt: number; queueId: string } {
  const expiresAt = validatePluginAsyncCallbackDeadline(binding, ttlMs, now);
  if (isIncognitoSessionKey(binding.childSessionKey)) {
    throw new Error("Incognito callbacks require their memory-only owner");
  }
  const token = randomBytes(32).toString("base64url");
  reserveCallbackSlot(database, binding, digest(token), now);
  const row: PendingCallback = { ...binding, status: "pending", expiresAt };
  executeSqliteQuerySync(
    database.db,
    ledger(database)
      .insertInto("plugin_state_entries")
      .values({
        plugin_id: LEDGER_PLUGIN_ID,
        namespace: LEDGER_NAMESPACE,
        entry_key: digest(token),
        value_json: JSON.stringify(row),
        created_at: now,
        // Terminal receipts survive expiry for duplicate classification; the
        // shared plugin-state maintenance eventually reclaims this bounded row.
        expires_at: expiresAt + PLUGIN_CALLBACK_RECEIPT_RETENTION_MS,
      }),
  );
  const expiry = preparePluginCallbackExpiry({ binding, key: digest(token), expiresAt, now });
  if (
    !upsertBoundDeliveryQueueEntryInDatabase(
      bindDeliveryQueueEntry({
        queueName: NATIVE_CHILD_DELIVERY_QUEUE_NAME,
        entry: expiry,
        insertOnly: true,
      }),
      database,
    )
  ) {
    throw new Error("Callback expiry identity is already in use");
  }
  return { token, expiresAt, queueId: expiry.id };
}

export type PluginAsyncCallbackCompletion =
  | { status: "accepted"; queueId: string }
  | { status: "duplicate"; queueId: string }
  | { status: "expired" | "cancelled" | "unknown" };

/** Child cancellation revokes only still-pending capabilities, never an admitted outbox. */
export function cancelPluginAsyncCallbackInDatabase(
  database: OpenClawStateDatabase,
  token: string,
  assertOwnerCurrent: (binding: Readonly<PluginAsyncCallbackBinding>) => void,
): "cancelled" | "completed" | "unknown" {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    return "unknown";
  }
  const key = digest(token);
  const row = readCallback(database, key);
  if (!row) {
    return "unknown";
  }
  if (row.status === "completed") {
    return "completed";
  }
  if (row.status === "cancelled") {
    return "cancelled";
  }
  assertOwnerCurrent(row);
  const result = executeSqliteQuerySync(
    database.db,
    ledger(database)
      .updateTable("plugin_state_entries")
      .set({ value_json: JSON.stringify({ ...row, status: "cancelled" }) })
      .where("plugin_id", "=", LEDGER_PLUGIN_ID)
      .where("namespace", "=", LEDGER_NAMESPACE)
      .where("entry_key", "=", key)
      .where("value_json", "=", JSON.stringify(row)),
  );
  if (result.numAffectedRows !== 1n) {
    throw new Error("Callback cancellation lost its pending owner");
  }
  releaseCallbackSlot(database, row, key);
  return "cancelled";
}

/** Complete and enqueue in the SAME write transaction; unknown outcomes are never replayed. */
export function completePluginAsyncCallbackInDatabase(params: {
  database: OpenClawStateDatabase;
  token: string;
  resultText: string;
  now?: number;
  /** Current host child/session/plugin lifecycle, checked again at the commit guard. */
  assertOwnerCurrent: (binding: Readonly<PluginAsyncCallbackBinding>) => void;
}): PluginAsyncCallbackCompletion {
  const { database } = params;
  if (!/^[A-Za-z0-9_-]{43}$/.test(params.token)) {
    return { status: "unknown" };
  }
  if (
    typeof params.resultText !== "string" ||
    params.resultText.length > PLUGIN_CALLBACK_MAX_RESULT_CHARS
  ) {
    throw new Error("Callback result exceeds its bounded text contract");
  }
  const key = digest(params.token);
  const row = readCallback(database, key);
  if (!row) {
    return { status: "unknown" };
  }
  if (row.status === "completed") {
    return { status: "duplicate", queueId: row.queueId! };
  }
  if (row.status === "cancelled") {
    return { status: "cancelled" };
  }
  const now = params.now ?? Date.now();
  if (row.status === "expired" || row.expiresAt <= now) {
    return { status: "expired" };
  }
  params.assertOwnerCurrent(row);
  const entry = preparePluginCallbackResult({
    binding: row,
    key,
    resultText: params.resultText,
    now,
  });
  const bound = bindDeliveryQueueEntry({
    queueName: NATIVE_CHILD_DELIVERY_QUEUE_NAME,
    entry,
    insertOnly: true,
  });
  if (!upsertBoundDeliveryQueueEntryInDatabase(bound, database)) {
    throw new Error("Callback session delivery identity is already in use");
  }
  const changed = executeSqliteQuerySync(
    database.db,
    ledger(database)
      .updateTable("plugin_state_entries")
      .set({ value_json: JSON.stringify({ ...row, status: "completed", queueId: entry.id }) })
      .where("plugin_id", "=", LEDGER_PLUGIN_ID)
      .where("namespace", "=", LEDGER_NAMESPACE)
      .where("entry_key", "=", key)
      .where("value_json", "=", JSON.stringify(row)),
  );
  if (changed.numAffectedRows !== 1n) {
    throw new Error("Callback claim changed before outbox admission");
  }
  return { status: "accepted", queueId: entry.id };
}

/** Expiry and completion serialize on the same ledger row in the shared worker. */
export function expirePluginAsyncCallbackInDatabase(
  database: OpenClawStateDatabase,
  key: string,
  now = Date.now(),
): boolean {
  if (!/^[a-f0-9]{64}$/.test(key)) {
    return false;
  }
  const row = readCallback(database, key);
  if (!row) {
    // GC may retire the receipt during an outage, but never its unfinished
    // reservation/outbox. The original expiry notice remains deliverable;
    // a cancelled/settled claim or any admitted result must not become expiry.
    const reservation = executeSqliteQueryTakeFirstSync(
      database.db,
      ledger(database)
        .selectFrom("plugin_state_entries")
        .select("entry_key")
        .where("plugin_id", "=", LEDGER_PLUGIN_ID)
        .where("namespace", "like", ACTIVE_NAMESPACE + ".%")
        .where("value_json", "=", JSON.stringify(key)),
    );
    if (!reservation) {
      return false;
    }
    const resultId = "native-child:" + digest("plugin-callback:" + key);
    if (
      getDeliveryQueueEntryOwnersInDatabase(
        database,
        [NATIVE_CHILD_DELIVERY_QUEUE_NAME],
        resultId,
      ).has(NATIVE_CHILD_DELIVERY_QUEUE_NAME)
    ) {
      return false;
    }
    const expiry = loadDeliveryQueueEntryInDatabase(
      database,
      NATIVE_CHILD_DELIVERY_QUEUE_NAME,
      "native-child:" + digest("plugin-callback-expiry:" + key),
      "pending",
    );
    // This is persisted outbox data: validate its immutable deadline rather
    // than trusting the mutable retry availability timestamp.
    return (
      expiry !== null &&
      "yieldDeadline" in expiry &&
      typeof expiry.yieldDeadline === "number" &&
      Number.isSafeInteger(expiry.yieldDeadline) &&
      now >= expiry.yieldDeadline - 60 * 60_000
    );
  }
  if (row.status === "completed" || row.status === "cancelled") {
    return false;
  }
  if (row.expiresAt > now) {
    throw new Error("Callback expiry is not due");
  }
  if (row.status !== "expired") {
    executeSqliteQuerySync(
      database.db,
      ledger(database)
        .updateTable("plugin_state_entries")
        .set({ value_json: JSON.stringify({ ...row, status: "expired" }) })
        .where("plugin_id", "=", LEDGER_PLUGIN_ID)
        .where("namespace", "=", LEDGER_NAMESPACE)
        .where("entry_key", "=", key),
    );
  }
  return true;
}

export function readPluginAsyncCallbackStatusInDatabase(
  database: OpenClawStateDatabase,
  token: string,
  assertOwnerCurrent: (binding: Readonly<PluginAsyncCallbackBinding>) => void,
  now = Date.now(),
): OpenClawPluginAsyncToolCallbackStatus {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    return { status: "unknown" };
  }
  const key = digest(token);
  const row = readCallback(database, key);
  if (!row) {
    return { status: "unknown" };
  }
  assertOwnerCurrent(row);
  if (row.status === "pending" && row.expiresAt <= now) {
    expirePluginAsyncCallbackInDatabase(database, key, now);
  }
  return {
    status:
      row.status === "completed"
        ? (row.deliveryStatus ?? "accepted")
        : row.status === "pending" && row.expiresAt <= now
          ? "expired"
          : row.status,
    expiresAt: row.expiresAt,
    storage: "persistent",
  };
}

export type PluginAsyncCallbackSettlement = {
  key: string;
  slot: string;
  queueId: string;
  expiry: boolean;
  outcome: "delivered" | "failed";
};

/** The queue owns terminal delivery; acceptance alone never releases its continuation slot. */
export function settlePluginAsyncCallbackInDatabase(
  database: OpenClawStateDatabase,
  params: PluginAsyncCallbackSettlement,
  now = Date.now(),
): void {
  const { key, slot } = params;
  const expectedId =
    "native-child:" +
    digest((params.expiry ? "plugin-callback-expiry:" : "plugin-callback:") + key);
  if (
    !/^[a-f0-9]{64}$/.test(key) ||
    !/^[a-f0-9]{64}$/.test(slot) ||
    params.queueId !== expectedId
  ) {
    throw new Error("Callback settlement has no matching delivery owner");
  }
  const row = readCallback(database, key);
  if (row && pluginAsyncCallbackSlot(row) !== slot) {
    throw new Error("Callback settlement changed its native child owner");
  }
  if (params.expiry && row?.status === "completed") {
    return; // Its separate accepted-result delivery still owns the slot.
  }
  if (params.expiry && !row) {
    const resultId = "native-child:" + digest("plugin-callback:" + key);
    const result = getDeliveryQueueEntryOwnersInDatabase(
      database,
      [NATIVE_CHILD_DELIVERY_QUEUE_NAME],
      resultId,
    ).get(NATIVE_CHILD_DELIVERY_QUEUE_NAME);
    if (result?.status === "pending") {
      return;
    }
  }
  if (row) {
    let next = row;
    if (!params.expiry) {
      if (row.status !== "completed" || row.queueId !== params.queueId) {
        throw new Error("Callback result settlement changed its admitted outbox");
      }
      next = { ...row, deliveryStatus: row.deliveryStatus ?? params.outcome };
    } else if (row.status === "pending") {
      next = { ...row, status: row.expiresAt <= now ? "expired" : "cancelled" };
    }
    if (next !== row) {
      const changed = executeSqliteQuerySync(
        database.db,
        ledger(database)
          .updateTable("plugin_state_entries")
          .set({ value_json: JSON.stringify(next) })
          .where("plugin_id", "=", LEDGER_PLUGIN_ID)
          .where("namespace", "=", LEDGER_NAMESPACE)
          .where("entry_key", "=", key)
          .where("value_json", "=", JSON.stringify(row)),
      );
      if (changed.numAffectedRows !== 1n) {
        throw new Error("Callback settlement lost its receipt owner");
      }
    }
    releaseCallbackSlot(database, row, key);
    return;
  }
  // A long outage can outlive the receipt's retention. The queue still carries
  // the exact reservation identity; do not reconstruct a capability or receipt.
  const reservation = executeSqliteQueryTakeFirstSync(
    database.db,
    ledger(database)
      .selectFrom("plugin_state_entries")
      .select("value_json")
      .where("plugin_id", "=", LEDGER_PLUGIN_ID)
      .where("namespace", "=", ACTIVE_NAMESPACE)
      .where("entry_key", "=", slot),
  );
  if (!reservation) {
    return;
  }
  const value: unknown = JSON.parse(reservation.value_json);
  if (!Array.isArray(value) || value[0] !== key || typeof value[1] !== "string") {
    return;
  }
  for (const [namespace, encoded] of [
    [ACTIVE_NAMESPACE, reservation.value_json],
    [pluginActiveNamespace(value[1]), JSON.stringify(key)],
  ] as const) {
    executeSqliteQuerySync(
      database.db,
      ledger(database)
        .deleteFrom("plugin_state_entries")
        .where("plugin_id", "=", LEDGER_PLUGIN_ID)
        .where("namespace", "=", namespace)
        .where("entry_key", "=", slot)
        .where("value_json", "=", encoded),
    );
  }
}
