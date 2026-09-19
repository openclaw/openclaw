import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { clearNodeSqliteKyselyCacheForDatabase } from "../../infra/kysely-sync.js";
import type { NativeErrorResponse } from "../../infra/native-error-response-schema.js";
import { serializeNativeErrorResponse } from "../../infra/native-error-response.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { SqliteSchemaVersionError } from "../../infra/sqlite-user-version.js";
import { serveWorkerTasks } from "../../infra/worker-task-pool.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../../state/openclaw-state-db-contract.js";
import { assertSupportedStateSchemaVersion } from "../../state/openclaw-state-db-schema-version.js";
import { readNativeHookRelayBridgeRow } from "./native-hook-relay-bridge-query.js";
import {
  readNativeHookRelayBridgeRecordRow,
  type NativeHookRelayBridgeRecord,
} from "./native-hook-relay-bridge-record.js";

export type NativeHookRelayClientRead = { relayId: string; stateDbPath: string };
export type NativeHookRelayClientReadResult =
  | { ok: true; record: NativeHookRelayBridgeRecord | undefined }
  | { ok: false; error: NativeErrorResponse; newerSchema: boolean };

function readRecord(params: NativeHookRelayClientRead): NativeHookRelayBridgeRecord | undefined {
  const db = openNodeSqliteDatabase(params.stateDbPath, { readOnly: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
    assertSupportedStateSchemaVersion(db, params.stateDbPath);
    return readNativeHookRelayBridgeRecordRow(readNativeHookRelayBridgeRow(db, params.relayId));
  } finally {
    clearNodeSqliteKyselyCacheForDatabase(db);
    db.close();
  }
}

serveWorkerTasks((input): NativeHookRelayClientReadResult => {
  try {
    if (
      !isRecord(input) ||
      typeof input.relayId !== "string" ||
      typeof input.stateDbPath !== "string"
    ) {
      throw new Error("Native hook relay locator worker requires a relay id and database path");
    }
    return {
      ok: true,
      record: readRecord({ relayId: input.relayId, stateDbPath: input.stateDbPath }),
    };
  } catch (value) {
    const error = toStringifiedError(value);
    return {
      ok: false,
      error: serializeNativeErrorResponse(error),
      newerSchema: error instanceof SqliteSchemaVersionError,
    };
  }
});
