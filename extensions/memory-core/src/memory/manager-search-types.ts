import type { searchChunksByEmbedding } from "./manager-search-vector.js";
import type { searchKeyword, searchPathKeyword } from "./manager-search.js";

export type MemoryKeywordWorkerQuery = {
  body: Omit<Parameters<typeof searchKeyword>[0], "db">;
  path: Omit<Parameters<typeof searchPathKeyword>[0], "db">;
  includeRecallMetadata?: boolean;
};

export type MemoryVectorWorkerQuery = Omit<
  Parameters<typeof searchChunksByEmbedding>[0],
  "db" | "signal"
>;
