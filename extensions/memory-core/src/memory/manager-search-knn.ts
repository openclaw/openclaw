// Memory Core plugin module implements the synchronous sqlite-vec KNN query body.
import type { DatabaseSync } from "node:sqlite";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/memory-core-host-engine-knn";
import { buildMemoryModelFilter, type MemorySearchRow } from "./manager-search-shared.js";
import { vectorToBlob } from "./vector-blob.js";

const VECTOR_KNN_OVERSAMPLE_FACTOR = 8;
// sqlite-vec v0.1.9 rejects KNN queries with k above 4096.
const MAX_VECTOR_KNN_K = 4096;
const SQL_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const SOURCE_FILTER_RE = /^(?:| AND c\.source IN \(\?(?:, \?)*\))$/u;

type VectorKnnRow = MemorySearchRow & { dist: number };

export type VectorKnnRequest = {
  vectorTable: string;
  providerModels: string[];
  queryVec: number[];
  limit: number;
  snippetMaxChars: number;
  sourceFilter: { sql: string; params: string[] };
};

export type VectorKnnResponse = {
  rows: VectorKnnRow[];
  fallbackScanRequired: boolean;
};

function readCount(row: unknown): number {
  if (!row || typeof row !== "object") {
    return 0;
  }
  const count = Reflect.get(row, "count");
  if (typeof count === "bigint") {
    return Number(count);
  }
  if (typeof count === "number") {
    return count;
  }
  return 0;
}

export function isVectorKnnRow(value: unknown): value is VectorKnnRow {
  if (!value || typeof value !== "object") {
    return false;
  }
  const id = Reflect.get(value, "id");
  const path = Reflect.get(value, "path");
  const startLine = Reflect.get(value, "start_line");
  const endLine = Reflect.get(value, "end_line");
  const text = Reflect.get(value, "text");
  const source = Reflect.get(value, "source");
  const dist = Reflect.get(value, "dist");
  return (
    typeof id === "string" &&
    typeof path === "string" &&
    typeof startLine === "number" &&
    typeof endLine === "number" &&
    typeof text === "string" &&
    (source === "memory" || source === "sessions") &&
    typeof dist === "number" &&
    Number.isFinite(dist)
  );
}

export function validateVectorKnnRequest(request: VectorKnnRequest): void {
  if (!SQL_IDENTIFIER_RE.test(request.vectorTable)) {
    throw new Error("invalid memory vector table identifier");
  }
  if (
    request.providerModels.length === 0 ||
    request.providerModels.some((model) => typeof model !== "string" || model.length === 0)
  ) {
    throw new Error("memory vector KNN requires at least one provider model");
  }
  if (!SOURCE_FILTER_RE.test(request.sourceFilter.sql)) {
    throw new Error("invalid memory vector source filter");
  }
  const placeholderCount = request.sourceFilter.sql.match(/\?/gu)?.length ?? 0;
  if (placeholderCount !== request.sourceFilter.params.length) {
    throw new Error("memory vector source filter parameter mismatch");
  }
  if (!Number.isSafeInteger(request.limit) || request.limit <= 0) {
    throw new Error("invalid memory vector KNN limit");
  }
  if (!Number.isSafeInteger(request.snippetMaxChars) || request.snippetMaxChars <= 0) {
    throw new Error("invalid memory vector KNN snippet limit");
  }
}

/**
 * Execute the complete synchronous sqlite-vec KNN/count sequence.
 *
 * This function must run outside the Gateway event loop for file-backed
 * indexes. It remains separately testable so the worker and query semantics do
 * not diverge.
 */
export function runVectorKnnQuery(
  db: Pick<DatabaseSync, "prepare">,
  request: VectorKnnRequest,
): VectorKnnResponse {
  validateVectorKnnRequest(request);
  const vectorModelFilter = buildMemoryModelFilter("c.model", request.providerModels);
  const qBlob = vectorToBlob(request.queryVec);
  const snippetByteLimit = request.snippetMaxChars * 4;
  const runVectorQuery = (candidateLimit: number) => {
    // TEXT substr stops at NUL, so retain the byte prefix when it contains one.
    // Four bytes per UTF-16 unit cover UTF-8/UTF-16 without scanning the full body;
    // truncateUtf16Safe below removes any excess or partial trailing code point.
    // CROSS JOIN is intentional: sqlite-vec must run KNN before chunk lookup.
    // Reordering the chunks table first repeats the KNN scan once per chunk.
    const queryRows = db
      .prepare(
        `SELECT c.id, c.path, c.start_line, c.end_line,\n` +
          `       CASE WHEN instr(substr(CAST(c.text AS BLOB), 1, ?), x'00') > 0\n` +
          `            THEN CAST(substr(CAST(c.text AS BLOB), 1, ?) AS TEXT)\n` +
          `            ELSE substr(c.text, 1, ?) END AS text,\n` +
          `       c.source,\n` +
          `       vec_distance_cosine(v.embedding, ?) AS dist\n` +
          `  FROM ${request.vectorTable} v\n` +
          `  CROSS JOIN memory_index_chunks c ON c.id = v.id\n` +
          ` WHERE v.embedding MATCH ? AND k = ? AND ${vectorModelFilter}${request.sourceFilter.sql}\n` +
          ` ORDER BY dist ASC\n` +
          ` LIMIT ?`,
      )
      .all(
        snippetByteLimit,
        snippetByteLimit,
        request.snippetMaxChars,
        qBlob,
        qBlob,
        candidateLimit,
        ...request.providerModels,
        ...request.sourceFilter.params,
        request.limit,
      );
    return queryRows.map((row) => {
      if (!isVectorKnnRow(row)) {
        throw new Error("memory vector KNN query returned an invalid row");
      }
      row.text = truncateUtf16Safe(row.text, request.snippetMaxChars);
      return row;
    });
  };

  const candidateLimit = Math.min(request.limit * VECTOR_KNN_OVERSAMPLE_FACTOR, MAX_VECTOR_KNN_K);
  let rows = runVectorQuery(candidateLimit);
  if (rows.length < request.limit) {
    // Only the widening/fallback thresholds matter; stop counting once they are known.
    const matchingChunkCountRow = db
      .prepare(
        `SELECT COUNT(*) AS count FROM (\n` +
          `  SELECT 1 FROM memory_index_chunks c WHERE ${vectorModelFilter}${request.sourceFilter.sql} LIMIT ?\n` +
          `)`,
      )
      .get(...request.providerModels, ...request.sourceFilter.params, request.limit);
    const matchingChunkCount = readCount(matchingChunkCountRow);
    if (matchingChunkCount > rows.length) {
      const vectorCountRow = db
        .prepare(`SELECT COUNT(*) AS count FROM (SELECT 1 FROM ${request.vectorTable} LIMIT ?)`)
        .get(MAX_VECTOR_KNN_K + 1);
      const vectorCount = readCount(vectorCountRow);
      const widenedLimit = Math.min(vectorCount, MAX_VECTOR_KNN_K);
      if (widenedLimit > candidateLimit) {
        rows = runVectorQuery(widenedLimit);
      }
      const requiredMatches = Math.min(request.limit, matchingChunkCount);
      if (vectorCount > MAX_VECTOR_KNN_K && rows.length < requiredMatches) {
        return { rows: [], fallbackScanRequired: true };
      }
    }
  }

  return { rows, fallbackScanRequired: false };
}
