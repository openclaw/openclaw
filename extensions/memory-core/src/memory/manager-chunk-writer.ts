import type { EngineConnection } from "openclaw/plugin-sdk/database-engine-worker-runtime";
import {
  encodeMemoryEmbedding,
  type MemoryChunk,
  type MemoryEntryProvenance,
  type MemorySource,
} from "openclaw/plugin-sdk/memory-core-host-engine-indexing";
import { isPostgresSqlConnection } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";

export type IndexedMemoryChunk = MemoryChunk & {
  importance: number | null;
  triggers: string | null;
  projectKey: string | null;
};

export type MemoryChunkWrite = {
  id: string;
  chunk: IndexedMemoryChunk;
  embedding?: number[];
  context: { path: string; source: MemorySource; model: string; now: number };
};
type ChunkDatabase = {
  memory_index_chunks: {
    id: string;
    path: string;
    source: MemorySource;
    start_line: number;
    end_line: number;
    hash: string;
    model: string;
    text: string;
    embedding: Uint8Array;
    updated_at: number;
  };
  memory_index_chunk_recall_metadata: {
    chunk_id: string;
    importance: number | null;
    triggers: string | null;
    project_key: string | null;
  };
  memory_index_chunk_provenance: {
    chunk_id: string;
    origin_class: MemoryEntryProvenance["originClass"];
    session_kind: MemoryEntryProvenance["sessionKind"];
    observed_at: number;
    supersedes_key: string | null;
  };
};

export function writeMemoryChunks(
  database: EngineConnection,
  rows: readonly MemoryChunkWrite[],
): void {
  if (rows.length === 0) {
    return;
  }
  const db = getNodeSqliteKysely<ChunkDatabase>(database);
  // PostgreSQL cannot update the same conflict key twice in one statement.
  // Preserve SQLite's last-write behavior separately for content and metadata.
  const written = new Map<string, MemoryChunkWrite & { embedding: number[] }>();
  const metadata = new Map<string, MemoryChunkWrite>();
  for (const row of rows) {
    metadata.set(row.id, row);
    if (row.embedding !== undefined) {
      written.set(row.id, { ...row, embedding: row.embedding });
    }
  }
  const latestRows = [...metadata.values()];
  if (written.size > 0) {
    executeSqliteQuerySync(
      database,
      db
        .insertInto("memory_index_chunks")
        .values(
          [...written.values()].map((row) => ({
            id: row.id,
            path: row.context.path,
            source: row.context.source,
            start_line: row.chunk.startLine,
            end_line: row.chunk.endLine,
            hash: row.chunk.hash,
            model: row.context.model,
            text: row.chunk.text,
            embedding: encodeMemoryEmbedding(row.embedding),
            updated_at: row.context.now,
          })),
        )
        .onConflict((conflict) =>
          conflict.column("id").doUpdateSet((eb) => ({
            hash: eb.ref("excluded.hash"),
            model: eb.ref("excluded.model"),
            text: eb.ref("excluded.text"),
            embedding: eb.ref("excluded.embedding"),
            updated_at: eb.ref("excluded.updated_at"),
          })),
        ),
    );
  }
  executeSqliteQuerySync(
    database,
    db
      .insertInto("memory_index_chunk_recall_metadata")
      .values(
        latestRows.map((row) => ({
          chunk_id: row.id,
          importance: row.chunk.importance,
          triggers: row.chunk.triggers,
          project_key: row.chunk.projectKey,
        })),
      )
      .onConflict((conflict) =>
        conflict.column("chunk_id").doUpdateSet((eb) => ({
          importance: eb.ref("excluded.importance"),
          triggers: eb.ref("excluded.triggers"),
          project_key: eb.ref("excluded.project_key"),
        })),
      ),
  );
  executeSqliteQuerySync(
    database,
    db
      .insertInto("memory_index_chunk_provenance")
      .values(
        latestRows.map((row) => {
          const provenance = row.chunk.provenance ?? {
            originClass: "untrusted" as const,
            sessionKind: "unknown" as const,
            observedAt: row.context.now,
          };
          return {
            chunk_id: row.id,
            origin_class: provenance.originClass,
            session_kind: provenance.sessionKind,
            observed_at: provenance.observedAt,
            supersedes_key: provenance.supersedesKey ?? null,
          };
        }),
      )
      .onConflict((conflict) =>
        conflict
          .column("chunk_id")
          .doUpdateSet((eb) => ({
            origin_class: eb.ref("excluded.origin_class"),
            session_kind: eb.ref("excluded.session_kind"),
            observed_at: eb.ref("excluded.observed_at"),
            supersedes_key: eb.ref("excluded.supersedes_key"),
          }))
          .where((eb) =>
            eb.or(
              (["origin_class", "session_kind", "observed_at", "supersedes_key"] as const).map(
                (column) =>
                  eb(
                    isPostgresSqlConnection(database)
                      ? `memory_index_chunk_provenance.${column}`
                      : column,
                    isPostgresSqlConnection(database) ? "is distinct from" : "is not",
                    eb.ref(`excluded.${column}`),
                  ),
              ),
            ),
          ),
      ),
  );
}
