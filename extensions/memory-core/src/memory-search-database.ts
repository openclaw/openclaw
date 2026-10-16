import type { DatabaseSync } from "node:sqlite";
import type { EngineConnection } from "openclaw/plugin-sdk/database-engine-worker-runtime";
import {
  DatabaseSearchCapabilityUnavailableError,
  getDatabaseEngineSelection,
  requireNodeSqlite,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";

const memoryPostgresDiagnostic =
  "PostgreSQL memory indexing is unavailable until the memory store supports the selected engine.";

/** Reject unavailable search before a missing store can become an empty native index. */
export function requireMemorySearchCapability(): void {
  if (getDatabaseEngineSelection()?.input !== undefined) {
    throw new DatabaseSearchCapabilityUnavailableError("fullText", memoryPostgresDiagnostic);
  }
}

/** Memory's native index stays unavailable until its owner supports the selected engine. */
export function requireMemorySearchDatabase(database: EngineConnection): DatabaseSync {
  if (database instanceof requireNodeSqlite().DatabaseSync) {
    return database;
  }
  throw new DatabaseSearchCapabilityUnavailableError("fullText", memoryPostgresDiagnostic);
}
