import type { DatabaseSync } from "node:sqlite";
import {
  readMemoryRecallMetadata,
  type MemorySource,
  MEMORY_INDEX_FTS_TABLE,
  MEMORY_INDEX_VECTOR_TABLE,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  tableExists,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import type { MemoryIndexMeta } from "./manager-reindex-state.js";
import { loadMemorySourceFileState } from "./manager-source-state.js";
import { resolvePersistedMemoryVectorIndexState } from "./manager-vector-rebuild-state.js";

export const MEMORY_INDEX_META_KEY = "memory_index_meta_v1";

export type MemoryDatabaseFacts = {
  meta: MemoryIndexMeta | null;
  serialized: string | null;
  revision: number;
  hasIndexedChunks: boolean;
  hasSemanticChunks: boolean;
};

/** One bounded snapshot; retained text and embeddings never cross this boundary. */
export function readMemoryDatabaseFacts(db: DatabaseSync): MemoryDatabaseFacts {
  const query = getNodeSqliteKysely<{
    memory_index_meta: { key: string; value: string };
    memory_index_state: { id: number; revision: number };
    memory_index_chunks: { model: string };
  }>(db);
  const row = executeSqliteQueryTakeFirstSync(
    db,
    query
      .selectFrom("memory_index_state")
      .select((eb) => [
        "revision",
        eb
          .selectFrom("memory_index_meta")
          .select("value")
          .where("key", "=", MEMORY_INDEX_META_KEY)
          .as("serialized"),
        eb.exists(eb.selectFrom("memory_index_chunks").select("model")).as("hasIndexedChunks"),
        eb
          .exists(
            eb.selectFrom("memory_index_chunks").select("model").where("model", "!=", "fts-only"),
          )
          .as("hasSemanticChunks"),
      ])
      .where("id", "=", 1),
  );
  if (!row || !Number.isSafeInteger(row.revision)) {
    throw new Error("Memory index revision is missing or invalid");
  }
  return {
    ...parseMemoryIndexMetadata(row.serialized),
    revision: row.revision,
    hasIndexedChunks: Boolean(row.hasIndexedChunks),
    hasSemanticChunks: Boolean(row.hasSemanticChunks),
  };
}

function readMemoryIndexMetadata(db: DatabaseSync) {
  const row = db
    .prepare("SELECT value FROM memory_index_meta WHERE key = ?")
    .get(MEMORY_INDEX_META_KEY);
  return parseMemoryIndexMetadata(row?.value);
}

function parseMemoryIndexMetadata(value: unknown) {
  if (typeof value !== "string" || !value) {
    return { meta: null, serialized: null };
  }
  try {
    // SAFETY: The memory index writer serializes MemoryIndexMeta under this key.
    return { meta: JSON.parse(value) as MemoryIndexMeta, serialized: value };
  } catch {
    return { meta: null, serialized: null };
  }
}

export type MemoryRetrievalIndexState = ReturnType<typeof readMemoryRetrievalIndexState>;

export function readMemoryRetrievalIndexState(db: DatabaseSync) {
  const { meta } = readMemoryIndexMetadata(db);
  const hasIndexedChunks =
    db.prepare("SELECT 1 FROM memory_index_chunks LIMIT 1").get() !== undefined;
  const hasFtsContent =
    !hasIndexedChunks &&
    tableExists(db, MEMORY_INDEX_FTS_TABLE) &&
    db.prepare(`SELECT 1 FROM ${MEMORY_INDEX_FTS_TABLE} LIMIT 1`).get() !== undefined;
  const vectorState =
    meta && meta.provider !== "none"
      ? resolvePersistedMemoryVectorIndexState({
          db,
          vectorTable: MEMORY_INDEX_VECTOR_TABLE,
          metaVectorDims: meta.vectorDims,
          hasSemanticChunks:
            db
              .prepare("SELECT 1 FROM memory_index_chunks WHERE model != 'fts-only' LIMIT 1")
              .get() !== undefined,
        })
      : { state: "empty" as const };
  return { meta, hasIndexedChunks, hasFtsContent, vectorState };
}

export type MemoryRecallQuery = {
  candidates: Array<{ id: string; path: string; source: MemorySource }>;
  includeMemoryMtimes: boolean;
};

export function readMemoryRecallData(db: DatabaseSync, request: MemoryRecallQuery) {
  const rows = readMemoryRecallMetadata(
    db,
    request.candidates.map((entry) => entry.id),
  );
  const sourceMtimes: Record<MemorySource, Map<string, number | undefined>> = {
    memory: new Map(),
    sessions: new Map(),
  };
  for (const source of ["sessions", "memory"] as const) {
    if (source === "memory" && !request.includeMemoryMtimes) {
      continue;
    }
    const paths = Array.from(
      new Set(
        request.candidates
          .filter((entry) => entry.source === source && rows.has(entry.id))
          .map((entry) => entry.path),
      ),
    );
    if (paths.length > 0) {
      sourceMtimes[source] = new Map(
        loadMemorySourceFileState({ db, source, paths }).map((row) => [row.path, row.mtime]),
      );
    }
  }
  return { rows, sourceMtimes };
}

export type MemoryRecallData = ReturnType<typeof readMemoryRecallData>;
