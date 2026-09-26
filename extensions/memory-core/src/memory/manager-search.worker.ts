import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { openOpenClawAgentDatabaseReadOnly } from "openclaw/plugin-sdk/memory-core-host-engine-knn";
import {
  readCuratedMemoryTriggerCandidates,
  readCuratedProjectMemoryCandidates,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  withOpenClawAgentDatabaseReadOnly,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { serveWorkerTasks } from "openclaw/plugin-sdk/worker-task-server";
import { bm25RankToScore, buildFtsQuery } from "./keyword-query.js";
import {
  readMemoryRetrievalIndexState,
  readMemoryRecallData,
  type MemoryRecallQuery,
} from "./manager-retrieval-read.js";
import { searchChunksByEmbedding } from "./manager-search-vector.js";
import { searchKeyword, searchPathKeyword } from "./manager-search.js";
import { inspectMemoryIndexPresenceInWorker } from "./manager-status-presence.js";

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
export type MemorySearchWorkerInput =
  | { kind: "prewarm" }
  | { kind: "presence"; databasePath: string }
  | ({ databasePath: string; agentId: string } & (
      | { kind: "keyword"; query: MemoryKeywordWorkerQuery; includeIndexState?: boolean }
      | { kind: "vector"; query: MemoryVectorWorkerQuery }
      | { kind: "index-state" }
      | ({ kind: "recall-metadata" } & MemoryRecallQuery)
      | {
          kind: "curated";
          projectsOnly: boolean;
          limit: number;
          activeProjectKeys?: string[];
          checkProvenanceRepair: boolean;
        }
    ));
type QueryResult<T> = { rows: T; error?: string };
export type MemorySearchWorkerOutput =
  | { kind: "prewarm" }
  | { kind: "presence"; present: boolean }
  | { kind: "index-state"; state: ReturnType<typeof readMemoryRetrievalIndexState> }
  | ({ kind: "recall-metadata" } & ReturnType<typeof readMemoryRecallData>)
  | {
      kind: "curated";
      rows: ReturnType<typeof readCuratedMemoryTriggerCandidates>;
      provenanceRepairPending: boolean;
    }
  | {
      kind: "keyword";
      indexState?: ReturnType<typeof readMemoryRetrievalIndexState>;
      body: QueryResult<Awaited<ReturnType<typeof searchKeyword>>>;
      path: QueryResult<Awaited<ReturnType<typeof searchPathKeyword>>>;
    }
  | { kind: "vector"; rows: Awaited<ReturnType<typeof searchChunksByEmbedding>> };

export type MemoryKeywordWorkerResult = Extract<MemorySearchWorkerOutput, { kind: "keyword" }>;

serveWorkerTasks(async (input): Promise<MemorySearchWorkerOutput> => {
  // SAFETY: The paired runtime constructs the private request union.
  const request = input as MemorySearchWorkerInput;
  if (request.kind === "prewarm") {
    // A reply confirms module evaluation without opening an index or loading a provider.
    return { kind: "prewarm" };
  }
  if (request.kind === "presence") {
    // This pre-manager probe also recognizes shipped memory-only databases.
    return { kind: "presence", present: inspectMemoryIndexPresenceInWorker(request.databasePath) };
  }
  if (request.kind === "recall-metadata") {
    const result = withOpenClawAgentDatabaseReadOnly(
      ({ db }) => readMemoryRecallData(db, request),
      { agentId: request.agentId, path: request.databasePath },
    );
    if (!result.found) {
      throw new Error(`Memory search database unavailable: ${result.reason}`);
    }
    return { kind: "recall-metadata", ...result.value };
  }
  const opened = openOpenClawAgentDatabaseReadOnly({
    agentId: request.agentId,
    path: request.databasePath,
  });
  if (!opened.found) {
    if (
      opened.reason === "database-missing" &&
      (request.kind === "index-state" || (request.kind === "keyword" && request.includeIndexState))
    ) {
      const state: ReturnType<typeof readMemoryRetrievalIndexState> = {
        meta: null,
        hasIndexedChunks: false,
        hasFtsContent: false,
        vectorState: { state: "empty" },
      };
      return request.kind === "index-state"
        ? { kind: "index-state", state }
        : { kind: "keyword", indexState: state, body: { rows: [] }, path: { rows: [] } };
    }
    throw new Error(`Memory search database unavailable: ${opened.reason}`);
  }
  const { db } = opened.database;
  try {
    if (request.kind === "index-state") {
      return { kind: "index-state", state: readMemoryRetrievalIndexState(db) };
    }
    if (request.kind === "curated") {
      const provenanceRepairPending =
        request.checkProvenanceRepair &&
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<{ memory_index_sources: { source: string; hash: string } }>(db)
            .selectFrom("memory_index_sources")
            .select("hash")
            .where("source", "=", "memory")
            .where("hash", "=", "")
            .limit(1),
        ).rows.length > 0;
      return {
        kind: "curated",
        provenanceRepairPending,
        rows: provenanceRepairPending
          ? []
          : request.projectsOnly
            ? readCuratedProjectMemoryCandidates(db, request.limit, request.activeProjectKeys ?? [])
            : readCuratedMemoryTriggerCandidates(db, request.limit, request.activeProjectKeys),
      };
    }
    if (request.kind === "vector") {
      return { kind: "vector", rows: await searchChunksByEmbedding({ ...request.query, db }) };
    }
    const indexState = request.includeIndexState ? readMemoryRetrievalIndexState(db) : undefined;
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
    return { kind: "keyword", body, path, ...(indexState ? { indexState } : {}) };
  } finally {
    // The caller retains its published-generation lease until this close and reply,
    // or until the pool confirms worker termination after cancellation.
    opened.database.close();
  }
});
