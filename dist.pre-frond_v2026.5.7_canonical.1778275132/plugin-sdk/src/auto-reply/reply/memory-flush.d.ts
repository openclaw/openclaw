import { type SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
export declare function resolveMemoryFlushContextWindowTokens(params: {
    modelId?: string;
    agentCfgContextTokens?: number;
    cfg?: OpenClawConfig;
    provider?: string;
}): number;
export declare function resolveMaxActiveTranscriptBytes(cfg?: OpenClawConfig): number | undefined;
export declare function shouldRunMemoryFlush(params: {
    entry?: Pick<SessionEntry, "totalTokens" | "totalTokensFresh" | "compactionCount" | "memoryFlushCompactionCount">;
    /**
     * Optional token count override for flush gating. When provided, this value is
     * treated as a fresh context snapshot and used instead of the cached
     * SessionEntry.totalTokens (which may be stale/unknown).
     */
    tokenCount?: number;
    contextWindowTokens: number;
    reserveTokensFloor: number;
    softThresholdTokens: number;
}): boolean;
export declare function shouldRunPreflightCompaction(params: {
    entry?: Pick<SessionEntry, "totalTokens" | "totalTokensFresh">;
    /**
     * Optional projected token count override for pre-run compaction gating.
     * When provided, this value is treated as a fresh estimate and used instead
     * of any cached SessionEntry total.
     */
    tokenCount?: number;
    contextWindowTokens: number;
    reserveTokensFloor: number;
    softThresholdTokens: number;
}): boolean;
/**
 * Returns true when a memory flush has already been performed for the current
 * compaction cycle. This prevents repeated flush runs within the same cycle —
 * important for both the token-based and transcript-size–based trigger paths.
 */
export declare function hasAlreadyFlushedForCurrentCompaction(entry: Pick<SessionEntry, "compactionCount" | "memoryFlushCompactionCount">): boolean;
