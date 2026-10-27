import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  runSqliteImmediateTransactionSync,
  tableExists,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";

/** One additive schema step; `apply` brings the database from `version - 1` to `version`. */
type SchemaStep = { version: number; apply: (db: DatabaseSync) => void };
/** Plugin-owned database schema: its steps and how to date a store written before stamping. */
export type KnowledgeSchema = {
  store: "state" | "registry";
  steps: readonly SchemaStep[];
  /** Version implied by an unstamped store's tables; undefined means not a Knowledge store. */
  detect: (db: DatabaseSync) => number | undefined;
};

type SchemaTables = { knowledge_schema: { store: string; version: number } };

/** Thrown when a database is not this schema, or was written by a newer Knowledge. */
export class UnrecognizedSchema extends Error {}

function stampedVersion(db: DatabaseSync, store: string): number | undefined {
  if (!tableExists(db, "knowledge_schema")) {
    return undefined;
  }
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<SchemaTables>(db)
      .selectFrom("knowledge_schema")
      .select("version")
      .where("store", "=", store),
  );
  return row?.version;
}

/** Whether a database already carries this schema's latest stamp. */
export function isKnowledgeSchemaCurrent(db: DatabaseSync, schema: KnowledgeSchema): boolean {
  return stampedVersion(db, schema.store) === schema.steps.at(-1)!.version;
}

/** Bring a Knowledge database to the latest schema version and stamp it.
 * Stores created before stamping are dated by their tables, so existing
 * databases keep working; their native header fields are left untouched. */
export function ensureKnowledgeSchema(db: DatabaseSync, schema: KnowledgeSchema): void {
  const latest = schema.steps.at(-1)!.version;
  const current = stampedVersion(db, schema.store);
  if (current === latest) {
    return;
  }
  if (current !== undefined && current > latest) {
    throw new UnrecognizedSchema(`Knowledge ${schema.store} database uses a newer schema.`);
  }
  runSqliteImmediateTransactionSync(db, () => {
    // Another connection may have migrated while this one waited for the write lock.
    const version = stampedVersion(db, schema.store) ?? schema.detect(db);
    if (version === undefined || version > latest) {
      throw new UnrecognizedSchema(`Not a recognized Knowledge ${schema.store} database.`);
    }
    for (const step of schema.steps) {
      if (step.version > version) {
        step.apply(db);
      }
    }
    db.exec(
      "CREATE TABLE IF NOT EXISTS knowledge_schema (store TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT",
    );
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<SchemaTables>(db)
        .insertInto("knowledge_schema")
        .values({ store: schema.store, version: latest })
        .onConflict((oc) => oc.column("store").doUpdateSet({ version: latest })),
    );
  });
}
