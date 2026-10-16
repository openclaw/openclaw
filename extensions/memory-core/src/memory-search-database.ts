import type { DatabaseSync } from "node:sqlite";
import {
  admitStoreSearch,
  DatabaseSearchCapabilityUnavailableError,
  getDatabaseEngineSelection,
  type EngineConnection,
} from "openclaw/plugin-sdk/database-engine-worker-runtime";
import { requireNodeSqlite } from "openclaw/plugin-sdk/memory-core-host-engine-storage";

/** Reject unavailable search before a missing store can become an empty native index. */
export function requireMemorySearchCapability(databasePath: string): void {
  const search = admitStoreSearch({ databasePath, input: getDatabaseEngineSelection()?.input }, {});
  if (!search.fullText) {
    throw new DatabaseSearchCapabilityUnavailableError("fullText");
  }
}

/** Memory's native index stays unavailable until the selected engine supports search. */
export function requireMemorySearchDatabase(database: EngineConnection): DatabaseSync {
  if (database instanceof requireNodeSqlite().DatabaseSync) {
    return database;
  }
  const search = admitStoreSearch(database, {});
  if (!search.fullText) {
    throw new DatabaseSearchCapabilityUnavailableError("fullText");
  }
  throw new Error("Memory indexing requires an admitted SQLite connection");
}
