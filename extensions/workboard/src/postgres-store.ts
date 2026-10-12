import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  PostgresSyncConnection,
  admitSqliteSchema,
  getAdmittedSqliteSchemaFacts,
  runSqliteImmediateTransactionSync,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import type { WorkboardDatabaseInput } from "./database-config.js";
import { WORKBOARD_POSTGRES_SCHEMA_SQL } from "./workboard-postgres-schema.js";
import { SCHEMA_VERSION } from "./workboard-schema.js";

export function openWorkboardPostgresDatabase(
  anchor: DatabaseSync,
  input: NonNullable<WorkboardDatabaseInput>,
) {
  const identity = runSqliteImmediateTransactionSync(anchor, () => {
    admitSqliteSchema(anchor);
    if (
      [...(getAdmittedSqliteSchemaFacts(anchor)?.tables ?? [])].some((name) =>
        name.startsWith("workboard_"),
      )
    ) {
      throw new Error(
        "Existing SQLite workboard data cannot switch engines in the experimental PostgreSQL pilot; porting is not supported yet.",
      );
    }
    anchor.exec(
      "CREATE TABLE IF NOT EXISTS openclaw_engine_anchor (store_id TEXT NOT NULL, engine TEXT NOT NULL CHECK (engine = 'postgres'), schema TEXT NOT NULL)",
    );
    const rows = anchor
      .prepare("SELECT store_id, engine, schema FROM openclaw_engine_anchor")
      .all();
    if (rows.length > 1) {
      throw new Error("Invalid workboard engine anchor: expected exactly one identity");
    }
    const row = rows[0];
    if (row) {
      if (
        typeof row.store_id !== "string" ||
        row.engine !== "postgres" ||
        typeof row.schema !== "string"
      ) {
        throw new Error("Invalid workboard PostgreSQL anchor identity");
      }
      return { storeId: row.store_id, schema: row.schema };
    }
    const storeId = randomUUID();
    const schema = `${input.schemaPrefix}_workboard_${storeId.replaceAll("-", "").slice(0, 16)}`;
    anchor
      .prepare(
        "INSERT INTO openclaw_engine_anchor (store_id, engine, schema) VALUES (?, 'postgres', ?)",
      )
      .run(storeId, schema);
    return { storeId, schema };
  });
  let db: PostgresSyncConnection;
  try {
    db = new PostgresSyncConnection(input.connection, identity.schema, anchor, identity.storeId);
  } catch {
    throw new Error(
      "Cannot open workboard PostgreSQL connection; verify database.postgres.connection and server availability.",
    );
  }
  try {
    db.exec(
      `BEGIN ISOLATION LEVEL READ COMMITTED; SELECT pg_advisory_xact_lock(${db.advisoryLockKey})`,
    );
    db.exec(`CREATE SCHEMA IF NOT EXISTS "${identity.schema.replaceAll('"', '""')}"`);
    db.exec(
      "CREATE TABLE IF NOT EXISTS openclaw_schema_meta (store TEXT PRIMARY KEY, version BIGINT NOT NULL, store_id TEXT NOT NULL)",
    );
    const meta = db
      .prepare("SELECT version, store_id FROM openclaw_schema_meta WHERE store = 'workboard'")
      .get();
    if (meta) {
      if (meta.store_id !== identity.storeId) {
        throw new Error(
          `Workboard PostgreSQL database identity mismatch: expected ${identity.storeId}, found ${String(meta.store_id)}`,
        );
      }
      if (meta.version !== SCHEMA_VERSION) {
        throw new Error(
          `Workboard PostgreSQL schema version mismatch: expected ${SCHEMA_VERSION}, found ${String(meta.version)}; PostgreSQL migrations are not supported yet`,
        );
      }
    } else {
      db.exec(WORKBOARD_POSTGRES_SCHEMA_SQL);
      db.prepare(
        "INSERT INTO openclaw_schema_meta (store, version, store_id) VALUES ('workboard', ?, ?)",
      ).run(SCHEMA_VERSION, identity.storeId);
    }
    db.exec("COMMIT");
    return db;
  } catch (error) {
    try {
      if (db.isTransaction) {
        db.exec("ROLLBACK");
      }
    } finally {
      db.close();
    }
    throw error;
  }
}
