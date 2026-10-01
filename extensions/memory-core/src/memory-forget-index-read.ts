import { loadSqliteVecExtension } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  openNodeSqliteDatabase,
  tableExists,
  withFreshOpenClawAgentDatabaseReadOnly,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { referencesSession, scrubMemoryContent } from "./memory-forget-content.js";
import type {
  ForgetDatabase,
  ForgetIndexPlan,
  ForgetIndexReadInput,
} from "./memory-forget-index-task.js";
import { isMemorySessionIndexable } from "./memory/manager-session-sync-state.js";

export async function readMemoryForgetIndexInWorker(
  request: ForgetIndexReadInput,
): Promise<ForgetIndexPlan> {
  const options = {
    agentId: request.agentId,
    path: request.databasePath,
    env: { OPENCLAW_STATE_DIR: request.stateDir },
  };
  const params = {
    agentId: request.agentId,
    changedPaths: new Set(request.changedPaths),
    removedPaths: new Set(request.removedPaths),
    sessionIds: new Set(request.sessionIds),
    excludedSessionIds: new Set(request.excludedSessionIds),
    entryKeys: new Set(request.entryKeys),
    corpusSnippets: new Set(request.corpusSnippets),
  };
  const result = withFreshOpenClawAgentDatabaseReadOnly(({ db }) => {
    const kysely = getNodeSqliteKysely<ForgetDatabase>(db);
    const indexedChunks = executeSqliteQuerySync(
      db,
      kysely
        .selectFrom("memory_index_chunks as chunk")
        .select(["chunk.id", "chunk.path", "chunk.source"])
        .$if(tableExists(db, "memory_index_chunk_provenance"), (query) =>
          query
            .leftJoin(
              "memory_index_chunk_provenance as provenance",
              "provenance.chunk_id",
              "chunk.id",
            )
            .select([
              "provenance.origin_class as originClass",
              "provenance.session_kind as sessionKind",
            ]),
        )
        .select((eb) =>
          eb
            .case("chunk.source")
            .when("sessions")
            .then("")
            .else(eb.ref("chunk.text"))
            .end()
            .as("text"),
        ),
    ).rows;
    const changedPaths = new Set(params.changedPaths);
    // Another workspace agent may already have scrubbed the shared file.
    // Its remaining indexed snapshot still owns evidence for this agent's purge.
    for (const chunk of indexedChunks) {
      if (
        chunk.source === "memory" &&
        scrubMemoryContent({ ...params, content: chunk.text }).content !== chunk.text
      ) {
        changedPaths.add(chunk.path);
      }
    }
    const chunks = indexedChunks.filter(
      (chunk) =>
        changedPaths.has(chunk.path) ||
        referencesSession(chunk.path, params.agentId, params.sessionIds) ||
        (params.sessionIds.size > 0 &&
          chunk.source === "sessions" &&
          (chunk.originClass === "system" ||
            !isMemorySessionIndexable({ sessionKind: chunk.sessionKind ?? "unknown" }) ||
            referencesSession(chunk.path, params.agentId, params.excludedSessionIds))),
    );
    const removedSessionPaths = new Set(
      chunks.filter((chunk) => chunk.source === "sessions").map((chunk) => chunk.path),
    );
    const sources = executeSqliteQuerySync(
      db,
      kysely.selectFrom("memory_index_sources").select(["path", "source"]),
    ).rows.filter(
      (source) =>
        params.removedPaths.has(source.path) ||
        (source.source === "sessions" && removedSessionPaths.has(source.path)),
    );
    const chunkIds = chunks.map((chunk) => chunk.id);
    const ftsRows =
      chunkIds.length > 0 && tableExists(db, "memory_index_chunks_fts")
        ? executeSqliteQuerySync(
            db,
            kysely
              .selectFrom("memory_index_chunks_fts")
              .select((eb) => eb.fn.countAll<number>().as("count"))
              .where(
                "rowid",
                "in",
                kysely
                  .selectFrom("memory_index_chunks")
                  .select("chunk_rowid")
                  .where("id", "in", chunkIds),
              ),
          ).rows[0]!.count
        : 0;
    const hasVectorTable = tableExists(db, "memory_index_chunks_vec");
    let embeddingCacheRows = 0;
    if (params.sessionIds.size > 0 && tableExists(db, "memory_embedding_cache")) {
      embeddingCacheRows = executeSqliteQuerySync(
        db,
        kysely
          .selectFrom("memory_embedding_cache")
          .select((eb) => eb.fn.countAll<number>().as("count")),
      ).rows[0]!.count;
    }
    return {
      chunks: chunks.map(({ id, path, source }) => ({ id, path, source })),
      sources,
      ftsRows,
      embeddingCacheRows,
      hasVectorTable,
    };
  }, options);
  if (!result.found) {
    return {
      chunks: [],
      sources: [],
      ftsRows: 0,
      vectorRows: 0,
      embeddingCacheRows: 0,
      hasVectorTable: false,
    };
  }
  let vectorRows = 0;
  let extensionPath: string | undefined;
  if (result.value.hasVectorTable && result.value.chunks.length > 0) {
    const probe = openNodeSqliteDatabase(":memory:", { allowExtension: true });
    let preparedExtensionPath: string;
    try {
      const loaded = await loadSqliteVecExtension({ db: probe });
      if (!loaded.ok || !loaded.extensionPath) {
        throw new Error(
          `memory forget cannot inspect vector index: ${loaded.error ?? "load failed"}`,
        );
      }
      preparedExtensionPath = loaded.extensionPath;
    } finally {
      probe.close();
    }
    extensionPath = preparedExtensionPath;
    // Preview must not create or migrate state; its owner-validated handle
    // stays read-only while exposing vec0.
    const vectorResult = withFreshOpenClawAgentDatabaseReadOnly(
      ({ db }) => {
        db.enableLoadExtension(true);
        db.loadExtension(preparedExtensionPath);
        const vectorKysely = getNodeSqliteKysely<ForgetDatabase>(db);
        return executeSqliteQuerySync(
          db,
          vectorKysely
            .selectFrom("memory_index_chunks_vec")
            .select((eb) => eb.fn.countAll<number>().as("count"))
            .where(
              "id",
              "in",
              result.value.chunks.map((chunk) => chunk.id),
            ),
        ).rows[0]!.count;
      },
      options,
      { allowExtension: true },
    );
    vectorRows = vectorResult.found ? vectorResult.value : 0;
  }
  return { ...result.value, vectorRows, extensionPath };
}
