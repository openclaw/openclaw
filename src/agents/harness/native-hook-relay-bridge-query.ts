import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";

type NativeHookRelayBridgeDatabase = Pick<DB, "native_hook_relay_bridges">;

export function readNativeHookRelayBridgeRow(database: DatabaseSync, relayId: string) {
  const db = getNodeSqliteKysely<NativeHookRelayBridgeDatabase>(database);
  return executeSqliteQueryTakeFirstSync(
    database,
    db.selectFrom("native_hook_relay_bridges").selectAll().where("relay_id", "=", relayId),
  );
}
