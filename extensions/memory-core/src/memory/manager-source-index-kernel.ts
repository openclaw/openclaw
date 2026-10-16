import type { DatabaseSync } from "node:sqlite";
import { sql } from "kysely";
import {
  encodeMemoryEmbedding,
  hashText,
  type MemorySource,
} from "openclaw/plugin-sdk/memory-core-host-engine-indexing";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  runSqliteImmediateTransactionSync,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import {
  writeMemoryChunks,
  type IndexedMemoryChunk,
  type MemoryChunkWrite,
} from "./manager-chunk-writer.js";
import { admitMemoryVectorIndex } from "./manager-search-knn.js";
import {
  markMemoryVectorRebuildRequired,
  resolveMemoryVectorIndexState,
  VECTOR_REBUILD_META_KEY,
} from "./manager-vector-rebuild-state.js";

const SOURCE_WRITE_BATCH_SIZE = 128;
const MAX_VECTOR_POINT_DELETES = 32;

export type MemorySourceIndexReplacement = {
  entry: { path: string; hash: string; mtimeMs: number; size: number };
  chunks: IndexedMemoryChunk[];
  embeddings: number[][];
  model: string;
  now: number;
  vectorReady: boolean;
} & (
  | { source: "memory" }
  | {
      source: "sessions";
      agentId: string;
      sessionId: string;
      /** Retained chunks whose recall metadata or provenance changed. */
      retained?: IndexedMemoryChunk[];
      /** Present for a delta; computed with retained rows in the owner's planning read. */
      removedIds?: string[];
    }
);

export type MemorySourceIndexHeader = Omit<
  MemorySourceIndexReplacement,
  "chunks" | "embeddings" | "retained" | "removedIds"
> &
  (
    | { source: "memory" }
    | { source: "sessions"; agentId: string; sessionId: string; delta?: boolean }
  );
/** A retained row refreshes metadata without replacing indexed text or embeddings. */
export type MemorySourceIndexRow =
  | { removedId: string }
  | {
      chunk: IndexedMemoryChunk;
      embedding: number[];
      retained?: boolean;
    };
type SourceIndexDatabase = {
  memory_index_meta: { key: string; value: string };
  memory_index_sources: {
    path: string;
    source: MemorySource;
    hash: string;
    mtime: number;
    size: number;
  };
  memory_index_chunks: {
    id: string;
    path: string;
    source: MemorySource;
    embedding: Uint8Array;
  };
  memory_index_chunk_recall_metadata: {
    chunk_id: string;
    importance: number | null;
    triggers: string | null;
    project_key: string | null;
  };
  memory_index_chunk_provenance: {
    chunk_id: string;
    origin_class: string;
    session_kind: string;
    observed_at: number;
    supersedes_key: string | null;
  };
};

type SourceIndexState = {
  vector: { enabled: boolean; available: boolean | null };
  fts: { enabled: boolean; available: boolean };
  hasVectorTable?: boolean;
};

export function memoryChunkRowId(
  source: MemorySource,
  pathname: string,
  chunk: Pick<IndexedMemoryChunk, "startLine" | "endLine" | "hash">,
  model: string,
): string {
  return hashText(
    `${source}:${pathname}:${chunk.startLine}:${chunk.endLine}:${chunk.hash}:${model}`,
  );
}

/** Indexed row ids of one source and whether each row stores an embedding. */
export function readMemorySourceChunks(db: DatabaseSync, source: MemorySource, path: string) {
  return executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<SourceIndexDatabase>(db)
      .selectFrom("memory_index_chunks")
      .leftJoin(
        "memory_index_chunk_recall_metadata as recall",
        "recall.chunk_id",
        "memory_index_chunks.id",
      )
      .leftJoin(
        "memory_index_chunk_provenance as provenance",
        "provenance.chunk_id",
        "memory_index_chunks.id",
      )
      .select((eb) => [
        "id",
        eb(eb.fn<number>("length", ["embedding"]), ">", 0).as("embedded"),
        "recall.importance",
        "recall.triggers",
        "recall.project_key as projectKey",
        "provenance.origin_class as originClass",
        "provenance.session_kind as sessionKind",
        "provenance.observed_at as observedAt",
        "provenance.supersedes_key as supersedesKey",
      ])
      .where("path", "=", path)
      .where("source", "=", source),
  ).rows.map((row) => Object.assign(row, { embedded: Boolean(row.embedded) }));
}

export function readMemorySourceHash(
  db: DatabaseSync,
  source: MemorySource,
  path: string,
): string | undefined {
  return executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<SourceIndexDatabase>(db)
      .selectFrom("memory_index_sources")
      .select("hash")
      .where("path", "=", path)
      .where("source", "=", source),
  )?.hash;
}

// The caller retains transaction admission and repeats file validation before
// each BEGIN attempt. This kernel runs only inside that admitted native transaction.
export class MemorySourceIndexKernel {
  private readonly search: ReturnType<typeof admitMemoryVectorIndex>;
  constructor(
    private readonly database: DatabaseSync,
    private readonly state: SourceIndexState,
  ) {
    this.search = admitMemoryVectorIndex(database);
  }

  replaceRows(params: MemorySourceIndexHeader, rows: Iterable<MemorySourceIndexRow>): void {
    const { entry, source, model, now, vectorReady } = params;
    const db = getNodeSqliteKysely<SourceIndexDatabase>(this.database);
    const delta = params.source === "sessions" && params.delta;
    // Re-read mutable rebuild debt in this transaction; table presence is an
    // admitted fact. Only a clean index relates stored embeddings to vectors.
    const reuse =
      !delta &&
      vectorReady &&
      resolveMemoryVectorIndexState({
        marker: executeSqliteQueryTakeFirstSync(
          this.database,
          db
            .selectFrom("memory_index_meta")
            .select("value")
            .where("key", "=", VECTOR_REBUILD_META_KEY),
        )?.value,
        hasVectorTable: this.state.hasVectorTable ?? this.state.vector.available === true,
        hasSemanticChunks: true,
      }).state === "complete";
    const previous = reuse
      ? new Set(
          executeSqliteQuerySync(
            this.database,
            db
              .selectFrom("memory_index_chunks")
              .select("id")
              .where("path", "=", entry.path)
              .where("source", "=", source),
          ).rows.map((row) => row.id),
        )
      : undefined;
    if (!delta && !reuse) {
      this.clear(entry.path, source);
    }
    let findVector: ((id: string) => boolean) | undefined;
    let batch: MemoryChunkWrite[] = [];
    let removedIds: string[] = [];
    let hasEmbeddings = false;
    const flush = () => {
      this.deleteIds(entry.path, source, removedIds);
      removedIds = [];
      // Decide from the last row for each ID before writing relational rows.
      // A repeated ID can change and then return to its original embedding.
      const reusable = new Set<string>();
      let vectors = [
        ...new Map(
          batch.flatMap((row) =>
            row.embedding === undefined
              ? []
              : [[row.id, { id: row.id, embedding: row.embedding }] as const],
          ),
        ).values(),
      ].filter((row) => {
        if (!reuse) {
          return row.embedding.length > 0;
        }
        findVector ??= this.search.capability.prepareExists(this.search.index);
        if (!findVector(row.id)) {
          return row.embedding.length > 0;
        }
        if (row.embedding.length === 0) {
          this.deleteVectors(entry.path, source, [row.id]);
          return false;
        }
        reusable.add(row.id);
        return true;
      });
      if (reusable.size > 0) {
        const previousEmbeddings = new Map(
          executeSqliteQuerySync(
            this.database,
            db
              .selectFrom("memory_index_chunks")
              .select(["id", "embedding"])
              .where("id", "in", [...reusable]),
          ).rows.map((row) => [row.id, row.embedding]),
        );
        vectors = vectors.filter((row) => {
          const old = previousEmbeddings.get(row.id);
          return !old || !Buffer.from(old).equals(encodeMemoryEmbedding(row.embedding));
        });
      }
      writeMemoryChunks(
        this.database,
        {
          path: entry.path,
          source,
          model,
          now,
        },
        batch,
      );
      if (vectorReady) {
        this.search.capability.write(this.search.index, vectors);
      }
      batch = [];
    };
    for (const row of rows) {
      if ("removedId" in row) {
        removedIds.push(row.removedId);
        if (removedIds.length === SOURCE_WRITE_BATCH_SIZE) {
          flush();
        }
        continue;
      }
      const { chunk, embedding, retained: keep } = row;
      const id = memoryChunkRowId(source, entry.path, chunk, model);
      previous?.delete(id);
      hasEmbeddings ||= !keep && embedding.length > 0;
      batch.push({ id, chunk, ...(keep ? {} : { embedding }) });
      if (batch.length === SOURCE_WRITE_BATCH_SIZE) {
        flush();
      }
    }
    flush();
    if (previous?.size) {
      this.deleteIds(entry.path, source, [...previous], "complete-replacement");
    }
    executeSqliteQuerySync(
      this.database,
      db
        .insertInto("memory_index_sources")
        .values({
          path: entry.path,
          source,
          hash: entry.hash,
          mtime: entry.mtimeMs,
          size: entry.size,
        })
        .onConflict((conflict) =>
          conflict.columns(["path", "source"]).doUpdateSet((eb) => ({
            hash: eb.ref("excluded.hash"),
            mtime: eb.ref("excluded.mtime"),
            size: eb.ref("excluded.size"),
          })),
        ),
    );
    if (!vectorReady && hasEmbeddings) {
      markMemoryVectorRebuildRequired(this.database);
    }
  }

  deleteIfCurrent(params: {
    path: string;
    source: MemorySource;
    expectedHash: string | undefined;
  }): boolean {
    if (readMemorySourceHash(this.database, params.source, params.path) !== params.expectedHash) {
      return false;
    }
    this.clear(params.path, params.source);
    executeSqliteQuerySync(
      this.database,
      getNodeSqliteKysely<SourceIndexDatabase>(this.database)
        .deleteFrom("memory_index_sources")
        .where("path", "=", params.path)
        .where("source", "=", params.source),
    );
    return true;
  }

  private deleteIds(
    pathname: string,
    source: MemorySource,
    ids: string[],
    cleanup: "session-delta" | "complete-replacement" = "session-delta",
  ): void {
    if (ids.length === 0) {
      return;
    }
    this.deleteVectors(pathname, source, ids, cleanup);
    // Recall metadata and provenance cascade; the body FTS trigger follows rowids.
    for (let offset = 0; offset < ids.length; offset += SOURCE_WRITE_BATCH_SIZE) {
      executeSqliteQuerySync(
        this.database,
        getNodeSqliteKysely<SourceIndexDatabase>(this.database)
          .deleteFrom("memory_index_chunks")
          .where("id", "in", ids.slice(offset, offset + SOURCE_WRITE_BATCH_SIZE)),
      );
    }
  }

  private deleteVectors(
    pathname: string,
    source: MemorySource,
    ids?: readonly string[],
    cleanup: "session-delta" | "complete-replacement" = "session-delta",
  ): void {
    if (!(this.state.hasVectorTable ?? this.state.vector.available === true)) {
      return;
    }
    if (!this.state.vector.enabled || this.state.vector.available !== true) {
      markMemoryVectorRebuildRequired(this.database);
      return;
    }
    try {
      // Keep cleanup atomic before recording rebuild debt on a caught failure.
      runSqliteImmediateTransactionSync(this.database, () => {
        const sparse =
          ids ??
          executeSqliteQuerySync(
            this.database,
            getNodeSqliteKysely<SourceIndexDatabase>(this.database)
              .selectFrom("memory_index_chunks")
              .select("id")
              .where("path", "=", pathname)
              .where("source", "=", source)
              .limit(MAX_VECTOR_POINT_DELETES + 1),
          ).rows.map((row) => row.id);
        if (
          (ids === undefined || cleanup === "complete-replacement") &&
          sparse.length > MAX_VECTOR_POINT_DELETES
        ) {
          // Dense complete replacements may scan once, restricted to stale IDs:
          // retained and newly written rows are already present in this source.
          // Session deltas always keep indexed scalar deletes, at every size.
          this.search.capability.remove(
            this.search.index,
            ids === undefined
              ? sql`SELECT id FROM memory_index_chunks WHERE path = ${pathname} AND source = ${source}`
              : sql`SELECT id FROM memory_index_chunks WHERE path = ${pathname} AND source = ${source} AND id IN (${this.search.capability.idSet(this.search.index, ids)})`,
          );
          return;
        }
        this.search.capability.remove(this.search.index, sparse);
      });
    } catch {
      markMemoryVectorRebuildRequired(this.database);
    }
  }

  private clear(pathname: string, source: MemorySource): void {
    this.deleteVectors(pathname, source);
    executeSqliteQuerySync(
      this.database,
      getNodeSqliteKysely<SourceIndexDatabase>(this.database)
        .deleteFrom("memory_index_chunks")
        .where("path", "=", pathname)
        .where("source", "=", source),
    );
  }
}
