import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";

type NativeHookRelayBridgeDatabase = Pick<DB, "native_hook_relay_bridges">;

export function readNativeHookRelayBridgeRow(database: EngineConnection, relayId: string) {
  const db = getNodeSqliteKysely<NativeHookRelayBridgeDatabase>(database);
  return executeSqliteQueryTakeFirstSync(
    database,
    db.selectFrom("native_hook_relay_bridges").selectAll().where("relay_id", "=", relayId),
  );
}
