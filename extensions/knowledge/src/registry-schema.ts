import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  tableExists,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import type { KnowledgeSchema } from "./storage-schema.js";

/** Kysely shapes of the store registry tables. */
export type RegistryTables = {
  stores: {
    vault_id: string;
    publication_id: string;
    root: string;
    state_path: string;
    state: string;
    created_at: string;
  };
  bindings: { binding: string; vault_id: string; label: string | null };
  meta: { key: string; value: string };
  operations: {
    request_id: string;
    intent: string;
    state: string;
    expected_revision: string;
    next_section: string;
    next_revision: string;
    rebind: string | null;
    message: string;
    updated_at: string;
  };
};

const REGISTRY_TABLES = ["stores", "bindings", "meta", "operations"];

/** Store registry schema. */
export const registrySchema: KnowledgeSchema = {
  store: "registry",
  steps: [
    {
      version: 1,
      apply: (db: DatabaseSync) => {
        db.exec(`CREATE TABLE stores (
        vault_id TEXT PRIMARY KEY, publication_id TEXT NOT NULL, root TEXT NOT NULL UNIQUE,
        state_path TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK(state IN ('initializing','ready')), created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE bindings (
        binding TEXT PRIMARY KEY, vault_id TEXT NOT NULL UNIQUE REFERENCES stores(vault_id), label TEXT
      ) STRICT;
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE operations (
        request_id TEXT PRIMARY KEY, intent TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','applied','not-applied','conflict')),
        expected_revision TEXT NOT NULL, next_section TEXT NOT NULL, next_revision TEXT NOT NULL,
        rebind TEXT, message TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;`);
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<RegistryTables>(db)
            .insertInto("meta")
            .values({ key: "registry_id", value: randomUUID() }),
        );
      },
    },
  ],
  // A registry written before stamping has all four tables; one without tables is new.
  detect: (db) => {
    const present = REGISTRY_TABLES.filter((name) => tableExists(db, name)).length;
    return present === REGISTRY_TABLES.length ? 1 : present === 0 ? 0 : undefined;
  },
};
