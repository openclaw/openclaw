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
