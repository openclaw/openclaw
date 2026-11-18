export type ForgetDatabase = {
  memory_index_chunks: {
    chunk_rowid: number;
    id: string;
    path: string;
    source: string;
    hash: string;
    text: string;
  };
  memory_index_sources: { path: string; source: string };
  memory_index_chunk_provenance: {
    chunk_id: string;
    origin_class: "owner" | "agent" | "untrusted" | "system";
    session_kind: "interactive" | "cron" | "heartbeat" | "subagent" | "unknown";
  };
  memory_index_chunks_fts: { rowid: number; id: string; path: string; source: string };
  memory_index_chunks_vec: { id: string };
  memory_embedding_cache: { hash: string };
  memory_index_state: { id: number; revision: number };
};

export type ForgetIndexPlan = {
  chunks: Array<Pick<ForgetDatabase["memory_index_chunks"], "id" | "path" | "source">>;
  sources: Array<ForgetDatabase["memory_index_sources"]>;
  ftsRows: number;
  vectorRows: number;
  embeddingCacheRows: number;
  hasVectorTable: boolean;
  extensionPath?: string;
};

export type ForgetIndexReadInput = {
  kind: "forget-index-plan";
  agentId: string;
  databasePath: string;
  stateDir: string;
  changedPaths: readonly string[];
  removedPaths: readonly string[];
  sessionIds: readonly string[];
  excludedSessionIds: readonly string[];
  entryKeys: readonly string[];
  corpusSnippets: readonly string[];
};

/** Keep generated IN lists below SQLite's variable limit during forget operations. */
export const MEMORY_FORGET_CHUNK_ID_BATCH_SIZE = 500;

export function forEachMemoryForgetChunkIdBatch<T>(
  chunkIds: readonly string[],
  visit: (batch: readonly string[]) => T,
): T[] {
  const results: T[] = [];
  for (let offset = 0; offset < chunkIds.length; offset += MEMORY_FORGET_CHUNK_ID_BATCH_SIZE) {
    results.push(visit(chunkIds.slice(offset, offset + MEMORY_FORGET_CHUNK_ID_BATCH_SIZE)));
  }
  return results;
}
