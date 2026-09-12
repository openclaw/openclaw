import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { openOpenClawAgentDatabaseReadOnly } from "openclaw/plugin-sdk/memory-core-host-engine-knn";
import { serveWorkerTasks } from "openclaw/plugin-sdk/process-runtime";
import { bm25RankToScore, buildFtsQuery } from "./keyword-query.js";
import { searchChunksByEmbedding, searchKeyword, searchPathKeyword } from "./manager-search.js";

type KeywordParameters = Omit<
  Parameters<typeof searchKeyword>[0],
  "db" | "buildFtsQuery" | "bm25RankToScore"
>;
type PathParameters = Omit<
  Parameters<typeof searchPathKeyword>[0],
  "db" | "buildFtsQuery" | "bm25RankToScore"
>;
export type MemoryKeywordWorkerQuery = { body: KeywordParameters; path: PathParameters };
export type MemoryVectorWorkerQuery = Omit<
  Parameters<typeof searchChunksByEmbedding>[0],
  "db" | "signal"
>;
export type MemorySearchWorkerInput = {
  databasePath: string;
  agentId: string;
} & (
  | { kind: "keyword"; query: MemoryKeywordWorkerQuery }
  | { kind: "vector"; query: MemoryVectorWorkerQuery }
);
type QueryResult<T> = { rows: T; error?: string };
export type MemorySearchWorkerOutput =
  | {
      kind: "keyword";
      body: QueryResult<Awaited<ReturnType<typeof searchKeyword>>>;
      path: QueryResult<Awaited<ReturnType<typeof searchPathKeyword>>>;
    }
  | { kind: "vector"; rows: Awaited<ReturnType<typeof searchChunksByEmbedding>> };

serveWorkerTasks(async (input): Promise<MemorySearchWorkerOutput> => {
  // SAFETY: The paired runtime constructs the request; the canonical reader validates the database owner.
  const request = input as MemorySearchWorkerInput;
  const opened = openOpenClawAgentDatabaseReadOnly({
    agentId: request.agentId,
    path: request.databasePath,
  });
  if (!opened.found) {
    throw new Error(`Memory search database unavailable: ${opened.reason}`);
  }
  const { db } = opened.database;
  try {
    if (request.kind === "vector") {
      return { kind: "vector", rows: await searchChunksByEmbedding({ ...request.query, db }) };
    }
    const body = await searchKeyword({ ...request.query.body, db, buildFtsQuery, bm25RankToScore })
      .then((rows) => ({ rows }))
      .catch((error: unknown) => ({ rows: [], error: formatErrorMessage(error) }));
    const path = await searchPathKeyword({
      ...request.query.path,
      db,
      buildFtsQuery,
      bm25RankToScore,
    })
      .then((rows) => ({ rows }))
      .catch((error: unknown) => ({ rows: [], error: formatErrorMessage(error) }));
    return { kind: "keyword", body, path };
  } finally {
    // The caller retains its published-generation lease until this close and reply,
    // or until the pool confirms worker termination after cancellation.
    opened.database.close();
  }
});
