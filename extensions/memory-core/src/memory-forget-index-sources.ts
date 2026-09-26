import type { DatabaseSync } from "node:sqlite";
import { parseUsageCountedSessionIdFromFileName } from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import { loadSqliteVecExtension } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  openNodeSqliteDatabase,
  sqliteStringSet,
  tableExists,
  withOpenClawAgentDatabaseReadOnly,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { isMemorySessionIndexable } from "./memory/manager-session-sync-state.js";

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

type ForgetIndexPlan = {
  chunks: Array<Pick<ForgetDatabase["memory_index_chunks"], "id" | "path" | "source">>;
  sources: Array<ForgetDatabase["memory_index_sources"]>;
  ftsRows: number;
  vectorRows: number;
  embeddingCacheRows: number;
  hasVectorTable: boolean;
};

export function referencesSession(
  value: string,
  agentId: string,
  sessionIds: ReadonlySet<string>,
): boolean {
  const agent = escapePattern(agentId);
  const references = new RegExp(
    `(?:^|[\\s[/:])(?:sessions/${agent}/|${agent}:(?!sessions/))([^\\s\\]#;:/]+)`,
    "gu",
  );
  // Decode archive filenames with the session owner's grammar; a shared prefix
  // or an arbitrary dotted suffix is not the selected session's identity.
  return (
    [...value.matchAll(references)].some(([, reference]) =>
      sessionIds.has(parseUsageCountedSessionIdFromFileName(reference!) ?? reference!),
    ) ||
    [...value.matchAll(/\bSession ID:\s*([^;\s]+)/giu)].some(([, sessionId]) =>
      sessionIds.has(sessionId!),
    )
  );
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export async function planMemoryIndex(params: {
  agentId: string;
  changedPaths: ReadonlySet<string>;
  removedPaths: ReadonlySet<string>;
  sessionIds: ReadonlySet<string>;
  excludedSessionIds: ReadonlySet<string>;
  matchesMemory: (content: string) => boolean;
}): Promise<ForgetIndexPlan> {
  const result = withOpenClawAgentDatabaseReadOnly(
    ({ db, path: databasePath }) => {
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
        if (chunk.source === "memory" && params.matchesMemory(chunk.text)) {
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
        const cacheCount = db
          .prepare("SELECT COUNT(*) AS count FROM memory_embedding_cache")
          // SAFETY: the aggregate query always returns one row with the declared count alias.
          .get() as { count?: unknown };
        embeddingCacheRows = Number(cacheCount.count ?? 0);
      }
      return { chunks, sources, ftsRows, embeddingCacheRows, hasVectorTable, databasePath };
    },
    { agentId: params.agentId },
  );
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
  if (result.value.hasVectorTable && result.value.chunks.length > 0) {
    const probe = openNodeSqliteDatabase(":memory:", { allowExtension: true });
    let extensionPath: string;
    try {
      const loaded = await loadSqliteVecExtension({ db: probe });
      if (!loaded.ok || !loaded.extensionPath) {
        throw new Error(
          `memory forget cannot inspect vector index: ${loaded.error ?? "load failed"}`,
        );
      }
      extensionPath = loaded.extensionPath;
    } finally {
      probe.close();
    }
    // Preview must not create or migrate state; its owner-validated handle
    // stays read-only while exposing vec0.
    const vectorResult = withOpenClawAgentDatabaseReadOnly(
      ({ db }) => {
        db.enableLoadExtension(true);
        db.loadExtension(extensionPath);
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
      { agentId: params.agentId },
      { allowExtension: true },
    );
    vectorRows = vectorResult.found ? vectorResult.value : 0;
  }
  return { ...result.value, vectorRows };
}

type MemoryIndexSource = { path: string; source: string };

// The forget owner supplies its selected rows and retains the purge transaction.
export function deleteMemoryIndexSources(
  database: DatabaseSync,
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
