import type { DatabaseSync } from "node:sqlite";
export type SearchSource = string;
export type SearchRowResult = {
    id: string;
    path: string;
    startLine: number;
    endLine: number;
    score: number;
    snippet: string;
    source: SearchSource;
};
export declare function searchVector(params: {
    db: DatabaseSync;
    vectorTable: string;
    providerModel: string;
    queryVec: number[];
    limit: number;
    snippetMaxChars: number;
    ensureVectorReady: (dimensions: number) => Promise<boolean>;
    sourceFilterVec: {
        sql: string;
        params: SearchSource[];
    };
    sourceFilterChunks: {
        sql: string;
        params: SearchSource[];
    };
}): Promise<SearchRowResult[]>;
export declare function listChunks(params: {
    db: DatabaseSync;
    providerModel: string;
    sourceFilter: {
        sql: string;
        params: SearchSource[];
    };
}): Array<{
    id: string;
    path: string;
    startLine: number;
    endLine: number;
    text: string;
    embedding: number[];
    source: SearchSource;
}>;
export declare function searchKeyword(params: {
    db: DatabaseSync;
    ftsTable: string;
    providerModel: string | undefined;
    query: string;
    limit: number;
    snippetMaxChars: number;
    sourceFilter: {
        sql: string;
        params: SearchSource[];
    };
    buildFtsQuery: (raw: string) => string | null;
    bm25RankToScore: (rank: number) => number;
}): Promise<Array<SearchRowResult & {
    textScore: number;
}>>;
