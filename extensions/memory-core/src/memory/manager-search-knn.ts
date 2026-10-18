import { sql } from "kysely";
import {
  admitStoreSearch,
  matchesVectorRow,
  type SearchStore,
  type VectorCapability,
  type VectorIndex,
} from "openclaw/plugin-sdk/memory-core-host-engine-knn";
import { MEMORY_INDEX_VECTOR_TABLE } from "openclaw/plugin-sdk/memory-core-host-engine-schema";
import { buildMemoryModelFilter, type MemorySearchRow } from "./manager-search-shared.js";

type VectorKnnRow = MemorySearchRow & { dist: number };
export type VectorKnnRequest = {
  providerModels: string[];
  queryVec: number[];
  limit: number;
  snippetMaxChars: number;
  sourceFilter: { sql: string; params: string[] };
};
export type VectorKnnResponse = { rows: VectorKnnRow[]; fallbackScanRequired: boolean };

const MEMORY_VECTOR_INDEX = {
  chunks: {
    table: MEMORY_INDEX_VECTOR_TABLE,
    alias: "v",
    rowShape: {
      id: "string",
      path: "string",
      start_line: "number",
      end_line: "number",
      text: "string",
      source: ["memory", "sessions"],
      dist: "finite-number",
    },
  },
} as const;

export function admitMemoryVectorIndex(store: SearchStore, table = MEMORY_INDEX_VECTOR_TABLE) {
  const search = admitStoreSearch(store, {
    vector: { chunks: { ...MEMORY_VECTOR_INDEX.chunks, table } },
  });
  const index = search.vectors.chunks;
  if (!search.vector || !index) {
    throw new Error(search.diagnostics.join("; "));
  }
  return { capability: search.vector, index };
}

export async function searchMemoryVectorIndex(
  capability: VectorCapability,
  index: VectorIndex,
  request: VectorKnnRequest,
  options: { signal?: AbortSignal; extensionPath?: string } = {},
): Promise<VectorKnnResponse> {
  const modelFilter = buildMemoryModelFilter("c.model", request.providerModels);
  const fragments = `${modelFilter}${request.sourceFilter.sql}`.split("?");
  const predicates = sql(
    Object.assign(fragments, { raw: fragments }),
    ...request.providerModels,
    ...request.sourceFilter.params,
  );
  const snippetByteLimit = request.snippetMaxChars * 4;
  return await capability.nearest({
    index,
    vector: request.queryVec,
    limit: request.limit,
    textPrefix: { column: "text", maxChars: request.snippetMaxChars },
    ...options,
    isRow: (value): value is VectorKnnRow =>
      matchesVectorRow(value, MEMORY_VECTOR_INDEX.chunks.rowShape),
    query: ({ match, distance }) => sql`SELECT c.id, c.path, c.start_line, c.end_line,
       CASE WHEN instr(substr(CAST(c.text AS BLOB), 1, ${snippetByteLimit}), x'00') > 0
            THEN CAST(substr(CAST(c.text AS BLOB), 1, ${snippetByteLimit}) AS TEXT)
            ELSE substr(c.text, 1, ${request.snippetMaxChars}) END AS text,
       c.source,
       ${distance} AS dist
  FROM ${sql.raw(index.table)} v
  CROSS JOIN memory_index_chunks c ON c.id = v.id
 WHERE ${match} AND ${predicates}
 ORDER BY dist ASC
 LIMIT ${request.limit}`,
    scopeCount: sql`SELECT COUNT(*) AS count FROM (
  SELECT 1 FROM memory_index_chunks c WHERE ${predicates} LIMIT ${request.limit}
)`,
  });
}
