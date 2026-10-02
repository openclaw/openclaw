import type { DatabaseSync } from "node:sqlite";
import {
  readMemoryRecallMetadata,
  type MemorySource,
  MEMORY_INDEX_FTS_TABLE,
  MEMORY_INDEX_VECTOR_TABLE,
  type MemoryVectorIndexState,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type { MemoryIndexMeta } from "./manager-reindex-state.js";
import { loadMemorySourceFileState } from "./manager-source-state.js";
import {
  memoryTableExists,
  resolvePersistedMemoryVectorIndexState,
} from "./manager-vector-rebuild-state.js";

export const MEMORY_INDEX_META_KEY = "memory_index_meta_v1";

export function readMemoryIndexMetadata(db: DatabaseSync): {
  meta: MemoryIndexMeta | null;
  serialized: string | null;
} {
  const row = db
    .prepare("SELECT value FROM memory_index_meta WHERE key = ?")
    .get(MEMORY_INDEX_META_KEY);
  if (typeof row?.value !== "string" || !row.value) {
    return { meta: null, serialized: null };
  }
  try {
    // SAFETY: The memory index writer serializes MemoryIndexMeta under this key.
    return { meta: JSON.parse(row.value) as MemoryIndexMeta, serialized: row.value };
  } catch {
    return { meta: null, serialized: null };
  }
}

export type MemoryRetrievalIndexState = {
  meta: MemoryIndexMeta | null;
  hasIndexedChunks: boolean;
  hasFtsContent: boolean;
  vectorState: MemoryVectorIndexState;
};

export function readMemoryRetrievalIndexState(db: DatabaseSync): MemoryRetrievalIndexState {
  const { meta } = readMemoryIndexMetadata(db);
  const hasIndexedChunks =
    db.prepare("SELECT 1 FROM memory_index_chunks LIMIT 1").get() !== undefined;
  const hasFtsContent =
    !hasIndexedChunks &&
    memoryTableExists(db, MEMORY_INDEX_FTS_TABLE) &&
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
