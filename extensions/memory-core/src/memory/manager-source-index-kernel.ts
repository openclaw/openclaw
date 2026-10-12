import type { DatabaseSync } from "node:sqlite";
import { hashText, type MemorySource } from "openclaw/plugin-sdk/memory-core-host-engine-indexing";
import { MEMORY_INDEX_VECTOR_TABLE } from "openclaw/plugin-sdk/memory-core-host-engine-schema";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  prepareSqliteQuerySync,
  runSqliteImmediateTransactionSync,
  tableExists,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { createMemoryChunkWriter, type IndexedMemoryChunk } from "./manager-chunk-writer.js";
import { markMemoryVectorRebuildRequired } from "./manager-vector-rebuild-state.js";
import { createMemoryVectorWriter } from "./manager-vector-write.js";

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
      /** Indexed chunks kept in place; publication refreshes only their provenance. */
      retained?: IndexedMemoryChunk[];
    }
);

export type MemorySourceIndexHeader = Omit<
  MemorySourceIndexReplacement,
  "chunks" | "embeddings" | "retained"
> &
  (
    | { source: "memory" }
    | { source: "sessions"; agentId: string; sessionId: string; delta?: boolean }
  );
/** A delta publication stages every retained row before its first written row. */
export type MemorySourceIndexRow = {
  chunk: IndexedMemoryChunk;
  embedding: number[];
  retained?: boolean;
};
/** Drift means a retained row vanished before the write lock and nothing was written. */
type MemorySourceIndexWriteResult = { retainedDrift: boolean };

type SourceIndexDatabase = {
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
};

type SourceIndexState = {
  vector: { enabled: boolean; available: boolean | null };
  fts: { enabled: boolean; available: boolean };
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
export function readMemorySourceChunks(
  db: DatabaseSync,
  source: MemorySource,
  path: string,
): Array<{ id: string; embedded: boolean }> {
  return executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<SourceIndexDatabase>(db)
      .selectFrom("memory_index_chunks")
      .select((eb) => ["id", eb(eb.fn<number>("length", ["embedding"]), ">", 0).as("embedded")])
      .where("path", "=", path)
      .where("source", "=", source),
  ).rows.map((row) => ({ id: row.id, embedded: Boolean(row.embedded) }));
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
  constructor(
    private readonly database: DatabaseSync,
    private readonly state: SourceIndexState,
  ) {}

  replaceRows(
    params: MemorySourceIndexHeader,
    rows: Iterable<MemorySourceIndexRow>,
  ): MemorySourceIndexWriteResult {
    const { entry, source, model, now, vectorReady } = params;
    // A session delta keeps unchanged rows and removes only ids this publication
    // omits. Live ids are read under the write lock, so a writer that committed
    // after planning cannot leave unknown rows behind.
    const liveIds =
      params.source === "sessions" && params.delta
        ? new Set(readMemorySourceChunks(this.database, source, entry.path).map((row) => row.id))
        : undefined;
    if (!liveIds) {
      this.clear(entry.path, source);
    }
    const desiredIds = new Set<string>();
    const retained: Array<{ id: string; chunk: IndexedMemoryChunk }> = [];
    let written = false;
    let writeChunk: ReturnType<typeof createMemoryChunkWriter> | undefined;
    // Empty sources must not construct unused chunk-write queries.
    const getChunkWriter = () =>
      (writeChunk ??= createMemoryChunkWriter(this.database, {
        path: entry.path,
        source,
        model,
        now,
      }));
    let writeVector: ReturnType<typeof createMemoryVectorWriter> | undefined;
    let hasEmbeddings = false;
    for (const { chunk, embedding, retained: keep } of rows) {
      const id = memoryChunkRowId(source, entry.path, chunk, model);
      desiredIds.add(id);
      if (keep) {
        if (!liveIds || written) {
          throw new Error("Memory publication retained rows must precede written rows");
        }
        if (!liveIds.has(id)) {
          return { retainedDrift: true };
        }
        retained.push({ id, chunk });
        continue;
      }
      written = true;
      hasEmbeddings ||= embedding.length > 0;
      getChunkWriter()(id, chunk, embedding);
      if (vectorReady && embedding.length > 0) {
        writeVector ??= createMemoryVectorWriter(this.database);
        writeVector(id, embedding);
      }
    }
    if (liveIds) {
      for (const { id, chunk } of retained) {
        getChunkWriter()(id, chunk);
      }
      this.deleteIds(
        entry.path,
        source,
        [...liveIds].filter((id) => !desiredIds.has(id)),
      );
    }
    const db = getNodeSqliteKysely<SourceIndexDatabase>(this.database);
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
    return { retainedDrift: false };
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

  private deleteIds(pathname: string, source: MemorySource, ids: string[]): void {
    if (ids.length === 0) {
      return;
    }
    this.deleteVectors(pathname, source, ids);
    // Recall metadata and provenance cascade; the body FTS trigger follows rowids.
    const remove = prepareSqliteQuerySync<string>(this.database, (parameter) =>
      getNodeSqliteKysely<SourceIndexDatabase>(this.database)
        .deleteFrom("memory_index_chunks")
        .where(
          "id",
          "=",
          parameter((id) => id),
        ),
    );
    for (const id of ids) {
      remove(id);
    }
  }

  private deleteVectors(pathname: string, source: MemorySource, ids?: readonly string[]): void {
    if (!tableExists(this.database, MEMORY_INDEX_VECTOR_TABLE)) {
      return;
    }
    if (!this.state.vector.enabled || this.state.vector.available !== true) {
      markMemoryVectorRebuildRequired(this.database);
      return;
    }
    try {
      // Point lookups avoid scanning unrelated vectors for small sources;
      // larger whole-source batches use one scan to bound native calls. Keep
      // either path atomic before recording rebuild debt on a caught failure.
      runSqliteImmediateTransactionSync(this.database, () => {
        const targets =
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
        if (!ids && targets.length > MAX_VECTOR_POINT_DELETES) {
          this.database
            .prepare(
              `DELETE FROM ${MEMORY_INDEX_VECTOR_TABLE} WHERE id IN (` +
                "SELECT id FROM memory_index_chunks WHERE path = ? AND source = ?)",
            )
            .run(pathname, source);
          return;
        }
        const removeVector = this.database.prepare(
          `DELETE FROM ${MEMORY_INDEX_VECTOR_TABLE} WHERE id = ?`,
        );
        for (const id of targets) {
          removeVector.run(id);
        }
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
