import { StatementSync } from "node:sqlite";
import { expect, it } from "vitest";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import type { NativeHookRelayBridgeRecord } from "./native-hook-relay-bridge-record.js";
import {
  deleteNativeHookRelayBridgeRecordIfOwnedInDatabase,
  pruneNativeHookRelayBridgeRecordsInDatabase,
  renewOrRestoreNativeHookRelayBridgeRecordInDatabase,
} from "./native-hook-relay-store.kernel.js";

it("settles relay ownership mutations without reading or overwriting a renewed locator", () => {
  const db = openNodeSqliteDatabase(":memory:");
  db.exec(`CREATE TABLE native_hook_relay_bridges (
    relay_id TEXT PRIMARY KEY, pid INTEGER, hostname TEXT, port INTEGER,
    token TEXT, expires_at_ms INTEGER, updated_at_ms INTEGER
  )`);
  const database = { db };
  const record: NativeHookRelayBridgeRecord = {
    relayId: "relay",
    pid: 100,
    hostname: "127.0.0.1",
    port: 1234,
    token: "synthetic-token",
    expiresAtMs: 100,
  };
  const observation = observeSqliteReadSql(StatementSync.prototype);
  try {
    expect(
      renewOrRestoreNativeHookRelayBridgeRecordInDatabase(database, {
        record,
        updatedAtMs: 1,
      }),
    ).toBe(true);
    const renewed = { ...record, expiresAtMs: 300 };
    expect(
      renewOrRestoreNativeHookRelayBridgeRecordInDatabase(database, {
        record: renewed,
        updatedAtMs: 2,
      }),
    ).toBe(true);
    expect(
      renewOrRestoreNativeHookRelayBridgeRecordInDatabase(database, {
        record: { ...record, token: "retired-token" },
        updatedAtMs: 3,
      }),
    ).toBe(false);
    expect(
      pruneNativeHookRelayBridgeRecordsInDatabase(
        database,
        [
          {
            snapshot: { record, updatedAtMs: 1 },
            reason: "expired",
          },
        ],
        200,
      ),
    ).toEqual([]);
    expect(
      deleteNativeHookRelayBridgeRecordIfOwnedInDatabase(database, {
        ...record,
        token: "retired-token",
      }),
    ).toBe(false);
    expect(observation.queries).toEqual([]);
    expect(db.prepare("SELECT expires_at_ms FROM native_hook_relay_bridges").get()).toEqual({
      expires_at_ms: 300,
    });
    expect(deleteNativeHookRelayBridgeRecordIfOwnedInDatabase(database, record)).toBe(true);
  } finally {
    observation.restore();
    db.close();
  }
});
