import type { MemoryRecallData, MemoryRetrievalIndexState } from "./manager-retrieval-read.js";
import type { SearchRowResult } from "./manager-search-shared.js";
import type { MemorySourceFilter } from "./source-filter.js";

export type MemoryKeywordWorkerQuery = {
  body: {
    ftsTable: string;
    query: string;
    ftsTokenizer?: "unicode61" | "trigram";
    limit: number;
    snippetMaxChars: number;
    sourceFilter: MemorySourceFilter;
    boostFallbackRanking?: boolean;
    matchAny?: boolean;
  };
  path: {
    pathFtsTable: string;
    query: string;
    exactPathLimit?: number;
    ftsTokenizer?: "unicode61" | "trigram";
    limit: number;
    snippetMaxChars: number;
    sourceFilter: MemorySourceFilter;
  };
  includeRecallMetadata?: boolean;
};

export type MemoryVectorWorkerQuery = {
  providerModel: string;
  providerModelAliases?: string[];
  sourceFilter: MemorySourceFilter;
  queryVec: number[];
  limit: number;
  snippetMaxChars: number;
  candidateIds?: string[];
};

export type ExactPathSpecificity = 0 | 1 | 2 | 3;

export type BodyKeywordSearchResult = SearchRowResult & { textScore: number; hasBodyMatch: true };

export type PathKeywordSearchResult = SearchRowResult & {
  textScore: 0;
  pathScore: number;
  exactPathSpecificity: ExactPathSpecificity;
  hasBodyMatch: false;
};

type QueryResult<T> = { rows: T; error?: string };

export type MemoryKeywordWorkerResult = {
  kind: "keyword";
  indexState?: MemoryRetrievalIndexState;
  recallData?: MemoryRecallData;
  body: QueryResult<BodyKeywordSearchResult[]>;
  path: QueryResult<PathKeywordSearchResult[]>;
};
