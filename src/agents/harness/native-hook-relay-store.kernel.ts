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

export type NativeHookRelayBridgePruneCandidate = {
  record: NativeHookRelayBridgeRecord;
  reason: NativeHookRelayBridgePruneResult["reason"];
};

export function readNativeHookRelayBridgeRecordFromDatabase(params: {
  database: { db: DatabaseSync };
  relayId: string;
}): NativeHookRelayBridgeRecord | undefined {
  return readNativeHookRelayBridgeRecordRow(
    readNativeHookRelayBridgeRow(params.database.db, params.relayId),
  );
}

function nativeHookRelayBridgeRow({
  record,
  updatedAtMs,
}: {
  record: NativeHookRelayBridgeRecord;
  updatedAtMs: number;
}): NativeHookRelayBridgeRow {
  return {
    relay_id: record.relayId,
    pid: record.pid,
    hostname: record.hostname,
    port: record.port,
    token: record.token,
    expires_at_ms: record.expiresAtMs,
    updated_at_ms: updatedAtMs,
  };
}

export function writeNativeHookRelayBridgeRecordInDatabase(
  database: { db: DatabaseSync },
  params: { record: NativeHookRelayBridgeRecord; updatedAtMs: number },
): void {
  const { relay_id, ...fields } = nativeHookRelayBridgeRow(params);
  const db = getNodeSqliteKysely<NativeHookRelayBridgeDatabase>(database.db);
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("native_hook_relay_bridges")
      .values({ relay_id, ...fields })
      .onConflict((conflict) => conflict.column("relay_id").doUpdateSet(fields)),
  );
}

export function renewOrRestoreNativeHookRelayBridgeRecordInDatabase(
  database: { db: DatabaseSync },
  params: { record: NativeHookRelayBridgeRecord; updatedAtMs: number },
): boolean {
  const { relay_id, ...fields } = nativeHookRelayBridgeRow(params);
  const db = getNodeSqliteKysely<NativeHookRelayBridgeDatabase>(database.db);
  const result = executeSqliteQuerySync(
    database.db,
    db
      .insertInto("native_hook_relay_bridges")
      .values({ relay_id, ...fields })
      .onConflict((conflict) =>
        conflict
          .column("relay_id")
          .doUpdateSet(fields)
          .where("native_hook_relay_bridges.pid", "=", params.record.pid)
          .where("native_hook_relay_bridges.token", "=", params.record.token),
      ),
  );
  return result.numAffectedRows === 1n;
}

export function deleteNativeHookRelayBridgeRecordIfOwnedInDatabase(
  database: { db: DatabaseSync },
  params: { relayId: string; pid: number; token: string },
): boolean {
  const db = getNodeSqliteKysely<NativeHookRelayBridgeDatabase>(database.db);
  const result = executeSqliteQuerySync(
    database.db,
    db
      .deleteFrom("native_hook_relay_bridges")
      .where("relay_id", "=", params.relayId)
      .where("pid", "=", params.pid)
      .where("token", "=", params.token),
  );
  return result.numAffectedRows === 1n;
}

export function listNativeHookRelayBridgeRecordsInDatabase(database: {
  db: DatabaseSync;
}): NativeHookRelayBridgeRecord[] {
  const db = getNodeSqliteKysely<NativeHookRelayBridgeDatabase>(database.db);
  return executeSqliteQuerySync(
    database.db,
    db.selectFrom("native_hook_relay_bridges").selectAll(),
  ).rows.flatMap((row) => {
    const record = readNativeHookRelayBridgeRecordRow(row);
    return record ? [record] : [];
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
    const { record } = candidate;
    let deletion = db
      .deleteFrom("native_hook_relay_bridges")
      .where("relay_id", "=", record.relayId)
      .where("pid", "=", record.pid)
      .where("token", "=", record.token);
    if (candidate.reason === "expired") {
      deletion = deletion.where("expires_at_ms", "<", nowMs);
    }
    const result = executeSqliteQuerySync(database.db, deletion);
    if (result.numAffectedRows === 1n) {
      pruned.push({
        relayId: record.relayId,
        pid: record.pid,
        reason: candidate.reason,
      });
    }
  }
  return pruned;
}
