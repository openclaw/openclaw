import { clearNodeSqliteKyselyCacheForDatabase } from "../../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { setSqliteBusyTimeout } from "../../infra/sqlite-busy-timeout.js";
import { assertSupportedStateSchemaVersion } from "../../state/openclaw-state-db-schema-version.js";
import { readNativeHookRelayBridgeRow } from "./native-hook-relay-bridge-query.js";
import {
  readNativeHookRelayBridgeRecordRow,
  type NativeHookRelayBridgeRecord,
} from "./native-hook-relay-bridge-record.js";

export type NativeHookRelayClientRead = { relayId: string; stateDbPath: string };

/** One-shot locator admission never initializes or migrates shared state. */
export function readNativeHookRelayClientRecord(
  params: NativeHookRelayClientRead,
  busyTimeoutMs: number,
): NativeHookRelayBridgeRecord | undefined {
  const db = openNodeSqliteDatabase(params.stateDbPath, { readOnly: true });
  try {
    setSqliteBusyTimeout(db, busyTimeoutMs);
    assertSupportedStateSchemaVersion(db, params.stateDbPath);
    return readNativeHookRelayBridgeRecordRow(readNativeHookRelayBridgeRow(db, params.relayId));
  } finally {
    clearNodeSqliteKyselyCacheForDatabase(db);
    db.close();
  }
}
