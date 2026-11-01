import type { EngineConnection } from "openclaw/plugin-sdk/database-engine-worker-runtime";
import {
  isPostgresSqlConnection,
  readMemoryEntryOriginsInDatabase,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  sqliteStringSet,
  tableExists,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import {
  selectedMemoryLineageIdentity,
  type MemoryEntryOriginOperations,
  type MemoryForgetLineage,
  type MemoryForgetLineageResult,
} from "./memory-entry-origins-task.js";
import type { ForgetDatabase } from "./memory-forget-index-task.js";
import { advanceMemoryIndexRevision } from "./memory-index-revision.worker.js";
import { recordMemorySessionTombstonesInDatabase } from "./memory-session-tombstones.js";

function checkLineage(db: EngineConnection, input: MemoryForgetLineage): MemoryForgetLineageResult {
  const origins = tableExists(db, "memory_entry_origins")
    ? readMemoryEntryOriginsInDatabase(db, { agentId: input.agentId })
    : [];
  return selectedMemoryLineageIdentity(
    origins,
    new Set(input.sessionIds),
    new Set(input.entryKeys),
  ) === input.identity
    ? { current: true }
    : { current: false, origins };
}

/** The binding owns this transaction and its commit grant. */
export function markMemoryForgotten(
  db: EngineConnection,
  input: MemoryForgetLineage,
): MemoryForgetLineageResult {
  const lineage = checkLineage(db, input);
  if (!lineage.current) {
    return lineage;
  }
  const recorded = recordMemorySessionTombstonesInDatabase(db, input);
  if (recorded === 0) {
    advanceMemoryIndexRevision(db);
  }
  return lineage;
}

/** The earlier tombstone commit survives any failure of this separate purge. */
export function purgeForgottenMemory(
  db: EngineConnection,
  input: MemoryEntryOriginOperations["forget.purge"]["input"],
): MemoryForgetLineageResult {
  const lineage = checkLineage(db, input);
  if (!lineage.current) {
    return lineage;
  }
  const kysely = getNodeSqliteKysely<ForgetDatabase>(db);
  if (input.chunkIds.length > 0) {
    // PostgreSQL owns generated text and vector FK projections; deleting the
    // source below removes both within this same owner transaction.
    if (input.hasVectorTable && !isPostgresSqlConnection(db)) {
      executeSqliteQuerySync(
        db,
        kysely.deleteFrom("memory_index_chunks_vec").where("id", "in", input.chunkIds),
      );
    }
    executeSqliteQuerySync(
      db,
      kysely
        .deleteFrom("memory_index_chunks")
        .where(
          "id",
          "in",
          isPostgresSqlConnection(db) ? sqliteStringSet(input.chunkIds) : input.chunkIds,
        ),
    );
  }
  deleteMemoryIndexSources(db, input.sources);
  if (tableExists(db, "memory_embedding_cache")) {
    executeSqliteQuerySync(db, kysely.deleteFrom("memory_embedding_cache"));
  }
  if (input.chunkIds.length > 0 || input.sources.length > 0) {
    advanceMemoryIndexRevision(db);
  }
  return lineage;
}

type MemoryIndexSource = { path: string; source: string };

// The forget owner supplies its selected rows and retains the purge transaction.
function deleteMemoryIndexSources(
  database: EngineConnection,
  sources: readonly MemoryIndexSource[],
): void {
  const db = getNodeSqliteKysely<{ memory_index_sources: MemoryIndexSource }>(database);
  for (let start = 0; start < sources.length;) {
    const source = sources[start]!;
    let end = start + 1;
    while (end < sources.length && sources[end]!.source === source.source) {
      end += 1;
    }
    executeSqliteQuerySync(
      database,
      db
        .deleteFrom("memory_index_sources")
        .where("path", "in", sqliteStringSet(sources.slice(start, end).map((row) => row.path)))
        .where("source", "=", source.source),
    );
    start = end;
  }
}
