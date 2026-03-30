import { type MMRConfig, DEFAULT_MMR_CONFIG } from "./mmr.js";
import { type TemporalDecayConfig, DEFAULT_TEMPORAL_DECAY_CONFIG } from "./temporal-decay.js";
export type HybridSource = string;
export { type MMRConfig, DEFAULT_MMR_CONFIG };
export { type TemporalDecayConfig, DEFAULT_TEMPORAL_DECAY_CONFIG };
export type HybridVectorResult = {
    id: string;
    path: string;
    startLine: number;
    endLine: number;
    source: HybridSource;
    snippet: string;
    vectorScore: number;
};
export type HybridKeywordResult = {
    id: string;
    path: string;
    startLine: number;
    endLine: number;
    source: HybridSource;
    snippet: string;
    textScore: number;
};
export declare function buildFtsQuery(raw: string): string | null;
export declare function bm25RankToScore(rank: number): number;
export declare function mergeHybridResults(params: {
    vector: HybridVectorResult[];
    keyword: HybridKeywordResult[];
    vectorWeight: number;
    textWeight: number;
    workspaceDir?: string;
    /** MMR configuration for diversity-aware re-ranking */
    mmr?: Partial<MMRConfig>;
    /** Temporal decay configuration for recency-aware scoring */
    temporalDecay?: Partial<TemporalDecayConfig>;
    /** Test seam for deterministic time-dependent behavior */
    nowMs?: number;
}): Promise<Array<{
    path: string;
    startLine: number;
    endLine: number;
    score: number;
    snippet: string;
    source: HybridSource;
}>>;
