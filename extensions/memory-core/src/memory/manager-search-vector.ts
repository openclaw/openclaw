import type { DatabaseSync } from "node:sqlite";
import {
  cosineSimilarity,
  decodeMemoryEmbedding,
  truncateUtf16Safe,
} from "openclaw/plugin-sdk/memory-core-host-engine-knn";
import type { MemorySource } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type { VectorKnnRequest, VectorKnnResponse } from "./manager-search-knn.js";
import { resolveSnippetProjection, type SearchRowResult } from "./manager-search-shared.js";

// Bound scan batches so worker cancellation can interrupt large vectorless indexes.
const FALLBACK_VECTOR_BATCH_SIZE = 256;

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

type SearchSource = MemorySource;

function resolveProviderModels(primary: string, aliases: string[] | undefined): string[] {
  return Array.from(new Set([primary, ...(aliases ?? []).filter(Boolean)]));
}

function buildModelFilter(column: string, models: string[]): string {
  return models.length === 1
    ? `${column} = ?`
    : `${column} IN (${models.map(() => "?").join(", ")})`;
}

export async function searchVector(params: {
  vectorTable: string;
  providerModel: string;
  providerModelAliases?: string[];
  queryVec: number[];
  limit: number;
  snippetMaxChars: number;
  signal?: AbortSignal;
  ensureVectorReady: (dimensions: number) => Promise<boolean>;
  runVectorKnn?: (request: VectorKnnRequest, signal?: AbortSignal) => Promise<VectorKnnResponse>;
  runFallback: () => Promise<SearchRowResult[]>;
  sourceFilterVec: { sql: string; params: SearchSource[] };
}): Promise<SearchRowResult[]> {
  if (params.queryVec.length === 0 || params.limit <= 0) {
    return [];
  }
  params.signal?.throwIfAborted();
  const providerModels = resolveProviderModels(params.providerModel, params.providerModelAliases);
  const vectorReady = await params.ensureVectorReady(params.queryVec.length);
  params.signal?.throwIfAborted();
  if (vectorReady) {
    if (!params.runVectorKnn) {
      throw new Error("memory vector KNN subprocess is unavailable");
    }
    const response = await params.runVectorKnn(
      {
        vectorTable: params.vectorTable,
        providerModels,
        queryVec: params.queryVec,
        limit: params.limit,
        snippetMaxChars: params.snippetMaxChars,
        sourceFilter: params.sourceFilterVec,
      },
      params.signal,
    );
    if (response.fallbackScanRequired) {
      return await params.runFallback();
    }
    return response.rows.map((row) => ({
      id: row.id,
      path: row.path,
      startLine: row.start_line,
      endLine: row.end_line,
      score: 1 - row.dist,
      snippet: truncateUtf16Safe(row.text, params.snippetMaxChars),
      source: row.source,
    }));
  }

  return await params.runFallback();
}

export async function searchChunksByEmbedding(params: {
  db: DatabaseSync;
  providerModel: string;
  providerModelAliases?: string[];
  sourceFilter: { sql: string; params: SearchSource[] };
  queryVec: number[];
  limit: number;
  snippetMaxChars: number;
  signal?: AbortSignal;
}): Promise<SearchRowResult[]> {
  if (params.limit <= 0) {
    return [];
  }
  const providerModels = resolveProviderModels(params.providerModel, params.providerModelAliases);
  const modelFilter = buildModelFilter("model", providerModels);
  // Keep batches bounded instead of calling `.all()` across the entire chunks
  // table, and do not hold a sqlite iterator open across the setImmediate yield
  // below. The rowid cursor keeps memory bounded without OFFSET rescans.
  const projection = `SELECT rowid AS rowid, embedding
  FROM memory_index_chunks
 WHERE ${modelFilter}`;
  const ordering = `${params.sourceFilter.sql}\n ORDER BY rowid ASC\n LIMIT ?`;
  // The first batch includes zero and negative identities, including INT64_MIN;
  // later batches retain an indexed range predicate and the exact native cursor.
  const firstStmt = params.db.prepare(`${projection}${ordering}`);
  const stmt = params.db.prepare(`${projection} AND rowid > ?${ordering}`);
  firstStmt.setReadBigInts(true);
  stmt.setReadBigInts(true);
  type ChunkEmbeddingRow = {
    rowid: bigint;
    embedding: Uint8Array;
  };
  const snippet = resolveSnippetProjection("text", params.snippetMaxChars);
  const payloadStmt = params.db.prepare(
    `SELECT id, path, start_line, end_line, ${snippet.sql} AS text, source FROM memory_index_chunks WHERE rowid = ?`,
  );
  type ChunkPayload = {
    id: string;
    path: string;
    start_line: number;
    end_line: number;
    text: string;
    source: SearchSource;
  };

  const topResults: SearchRowResult[] = [];
  let lastRowid: bigint | undefined;
  while (true) {
    const rows =
      lastRowid === undefined
        ? firstStmt.iterate(
            ...providerModels,
            ...params.sourceFilter.params,
            FALLBACK_VECTOR_BATCH_SIZE,
          )
        : stmt.iterate(
            ...providerModels,
            lastRowid,
            ...params.sourceFilter.params,
            FALLBACK_VECTOR_BATCH_SIZE,
          );
    // SAFETY: Both scans read INTEGER rowids as bigint and embeddings from a STRICT BLOB column.
    const batch = rows as IterableIterator<ChunkEmbeddingRow>;
    let batchSize = 0;
    for (const row of batch) {
      batchSize += 1;
      lastRowid = row.rowid;
      const score = cosineSimilarity(params.queryVec, decodeMemoryEmbedding(row.embedding));
      const lowest = topResults.at(-1);
      if (
        Number.isFinite(score) &&
        (topResults.length < params.limit || (lowest && score > lowest.score))
      ) {
        // Hydrate contenders before yielding so an old score cannot acquire a
        // replacement chunk's payload.
        // SAFETY: these schema-defined columns belong to this rowid in the active read snapshot.
        const payload = payloadStmt.get(...snippet.params, row.rowid) as ChunkPayload;
        const result: SearchRowResult = {
          id: payload.id,
          path: payload.path,
          startLine: payload.start_line,
          endLine: payload.end_line,
          score,
          snippet: truncateUtf16Safe(payload.text, params.snippetMaxChars),
          source: payload.source,
        };
        if (topResults.length < params.limit) {
          topResults.push(result);
          if (topResults.length === params.limit) {
            topResults.sort((a, b) => b.score - a.score);
          }
        } else {
          topResults[topResults.length - 1] = result;
          topResults.sort((a, b) => b.score - a.score);
        }
      }
    }
    if (batchSize < FALLBACK_VECTOR_BATCH_SIZE) {
      break;
    }
    await yieldToEventLoop();
    params.signal?.throwIfAborted();
  }
  topResults.sort((a, b) => b.score - a.score);
  return topResults;
}
