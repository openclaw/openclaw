import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { threadId } from "node:worker_threads";
import { openNodeSqliteDatabase } from "../../src/infra/node-sqlite.js";
import { PostgresSyncConnection } from "../../src/infra/postgres-sync/connection.js";
import type { SqliteWorkerPreparedBackend } from "../../src/infra/sqlite-worker-contract.js";

export type PoolFixtureOperations = {
  query: {
    input: { sleep?: boolean; marker?: string };
    output: { worker: number; postgres: boolean };
  };
};

export function createSqliteWorkerBackend(
  input: { sqliteOnly?: boolean } | undefined,
  context: { databasePath: string },
): SqliteWorkerPreparedBackend<PoolFixtureOperations> {
  const anchor = openNodeSqliteDatabase(context.databasePath);
  const dsn = process.env.PGFOOTPRINT_DSN;
  assert.ok(dsn);
  const db = input?.sqliteOnly
    ? undefined
    : new PostgresSyncConnection(dsn, "public", anchor, randomUUID());
  return {
    execute(command) {
      if (command.input.sleep) {
        assert.match(command.input.marker ?? "", /^[a-f0-9]+$/);
        db!.query(`SELECT pg_sleep(30) /* ${command.input.marker} */`);
      }
      if (db) {
        assert.equal(db.prepare("SELECT 1 AS ok").get()?.ok, 1);
      }
      return { worker: threadId, postgres: db !== undefined };
    },
    close() {
      db?.close();
      anchor.close();
    },
  };
}
