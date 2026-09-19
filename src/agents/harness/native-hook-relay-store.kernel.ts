import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import { readNativeHookRelayBridgeRow } from "./native-hook-relay-bridge-query.js";
import {
  readNativeHookRelayBridgeRecordRow,
  type NativeHookRelayBridgeRecord,
} from "./native-hook-relay-bridge-record.js";

export type NativeHookRelayBridgePruneResult = {
  relayId: string;
  pid: number;
  reason: "dead-pid" | "expired";
};

type NativeHookRelayBridgeDatabase = Pick<OpenClawStateKyselyDatabase, "native_hook_relay_bridges">;

type NativeHookRelayBridgeRow = OpenClawStateKyselyDatabase["native_hook_relay_bridges"];

export type NativeHookRelayBridgeSnapshot = {
  record: NativeHookRelayBridgeRecord;
  updatedAtMs: number;
};

export type NativeHookRelayBridgePruneCandidate = {
  snapshot: NativeHookRelayBridgeSnapshot;
  reason: NativeHookRelayBridgePruneResult["reason"];
};

function readNativeHookRelayBridgeSnapshot(
  row: NativeHookRelayBridgeRow | undefined,
): NativeHookRelayBridgeSnapshot | undefined {
  const record = readNativeHookRelayBridgeRecordRow(row);
  if (!record || !row || !Number.isSafeInteger(row.updated_at_ms)) {
    return undefined;
  }
  return {
    record,
    updatedAtMs: row.updated_at_ms,
  };
}

export function readNativeHookRelayBridgeSnapshotFromDatabase(params: {
  database: { db: DatabaseSync };
  relayId: string;
}): NativeHookRelayBridgeSnapshot | undefined {
  return readNativeHookRelayBridgeSnapshot(
    readNativeHookRelayBridgeRow(params.database.db, params.relayId),
  );
}

function sameNativeHookRelayBridgeSnapshot(
  left: NativeHookRelayBridgeSnapshot,
  right: NativeHookRelayBridgeSnapshot,
): boolean {
  return (
    left.updatedAtMs === right.updatedAtMs &&
    left.record.relayId === right.record.relayId &&
    left.record.pid === right.record.pid &&
    left.record.hostname === right.record.hostname &&
    left.record.port === right.record.port &&
    left.record.token === right.record.token &&
    left.record.expiresAtMs === right.record.expiresAtMs
  );
}

export function writeNativeHookRelayBridgeRecordInDatabase(
  database: { db: DatabaseSync },
  params: { record: NativeHookRelayBridgeRecord; updatedAtMs: number },
): void {
  const { record, updatedAtMs } = params;
  const { token } = record;
  const db = getNodeSqliteKysely<NativeHookRelayBridgeDatabase>(database.db);
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("native_hook_relay_bridges")
      .values({
        relay_id: record.relayId,
        pid: record.pid,
        hostname: record.hostname,
        port: record.port,
        token,
        expires_at_ms: record.expiresAtMs,
        updated_at_ms: updatedAtMs,
      })
      .onConflict((conflict) =>
        conflict.column("relay_id").doUpdateSet({
          pid: record.pid,
          hostname: record.hostname,
          port: record.port,
          token,
          expires_at_ms: record.expiresAtMs,
          updated_at_ms: updatedAtMs,
        }),
      ),
  );
}

export function renewOrRestoreNativeHookRelayBridgeRecordInDatabase(
  database: { db: DatabaseSync },
  params: { record: NativeHookRelayBridgeRecord; updatedAtMs: number },
): boolean {
  const { record, updatedAtMs } = params;
  const { token } = record;
  const db = getNodeSqliteKysely<NativeHookRelayBridgeDatabase>(database.db);
  const current = readNativeHookRelayBridgeSnapshotFromDatabase({
    database,
    relayId: record.relayId,
  });
  if (!current) {
    const result = executeSqliteQuerySync(
      database.db,
      db
        .insertInto("native_hook_relay_bridges")
        .values({
          relay_id: record.relayId,
          pid: record.pid,
          hostname: record.hostname,
          port: record.port,
          token,
          expires_at_ms: record.expiresAtMs,
          updated_at_ms: updatedAtMs,
        })
        .onConflict((conflict) => conflict.column("relay_id").doNothing()),
    );
    return result.numAffectedRows === 1n;
  }
  if (current.record.pid !== record.pid || current.record.token !== token) {
    return false;
  }
  const result = executeSqliteQuerySync(
    database.db,
    db
      .updateTable("native_hook_relay_bridges")
      .set({
        hostname: record.hostname,
        port: record.port,
        expires_at_ms: record.expiresAtMs,
        updated_at_ms: updatedAtMs,
      })
      .where("relay_id", "=", record.relayId)
      .where("pid", "=", record.pid)
      .where("token", "=", token)
      .where("updated_at_ms", "=", current.updatedAtMs),
  );
  return result.numAffectedRows === 1n;
}

export function deleteNativeHookRelayBridgeRecordIfOwnedInDatabase(
  database: { db: DatabaseSync },
  params: { relayId: string; pid: number; token: string },
): boolean {
  const current = readNativeHookRelayBridgeSnapshotFromDatabase({
    database,
    relayId: params.relayId,
  });
  if (!current || current.record.pid !== params.pid || current.record.token !== params.token) {
    return false;
  }
  const db = getNodeSqliteKysely<NativeHookRelayBridgeDatabase>(database.db);
  const result = executeSqliteQuerySync(
    database.db,
    db
      .deleteFrom("native_hook_relay_bridges")
      .where("relay_id", "=", params.relayId)
      .where("pid", "=", params.pid)
      .where("token", "=", params.token)
      .where("updated_at_ms", "=", current.updatedAtMs),
  );
  return result.numAffectedRows === 1n;
}

export function listNativeHookRelayBridgeSnapshotsInDatabase(database: {
  db: DatabaseSync;
}): NativeHookRelayBridgeSnapshot[] {
  const db = getNodeSqliteKysely<NativeHookRelayBridgeDatabase>(database.db);
  return executeSqliteQuerySync(
    database.db,
    db.selectFrom("native_hook_relay_bridges").selectAll(),
  ).rows.flatMap((row) => {
    const snapshot = readNativeHookRelayBridgeSnapshot(row);
    return snapshot ? [snapshot] : [];
  });
}

export function pruneNativeHookRelayBridgeRecordsInDatabase(
  database: { db: DatabaseSync },
  candidates: NativeHookRelayBridgePruneCandidate[],
  nowMs: number,
): NativeHookRelayBridgePruneResult[] {
  const db = getNodeSqliteKysely<NativeHookRelayBridgeDatabase>(database.db);
  const pruned: NativeHookRelayBridgePruneResult[] = [];
  for (const candidate of candidates) {
    const current = readNativeHookRelayBridgeSnapshotFromDatabase({
      database,
      relayId: candidate.snapshot.record.relayId,
    });
    if (
      !current ||
      !sameNativeHookRelayBridgeSnapshot(current, candidate.snapshot) ||
      (candidate.reason === "expired" && nowMs <= current.record.expiresAtMs)
    ) {
      continue;
    }
    const result = executeSqliteQuerySync(
      database.db,
      db
        .deleteFrom("native_hook_relay_bridges")
        .where("relay_id", "=", current.record.relayId)
        .where("token", "=", current.record.token)
        .where("updated_at_ms", "=", current.updatedAtMs),
    );
    if (result.numAffectedRows === 1n) {
      pruned.push({
        relayId: current.record.relayId,
        pid: current.record.pid,
        reason: candidate.reason,
      });
    }
  }
  return pruned;
}

export function clearNativeHookRelayBridgeRecordsInDatabase(database: { db: DatabaseSync }): void {
  const db = getNodeSqliteKysely<NativeHookRelayBridgeDatabase>(database.db);
  executeSqliteQuerySync(database.db, db.deleteFrom("native_hook_relay_bridges"));
}
