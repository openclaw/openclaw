import type { OpenClawConfig } from "../../config/config.js";
import { type SessionEntry } from "../../config/sessions.js";
export declare const DEFAULT_MEMORY_FLUSH_SOFT_TOKENS = 4000;
export declare const DEFAULT_MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES: number;
export declare const DEFAULT_MEMORY_FLUSH_PROMPT: string;
export declare const DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT: string;
export declare function resolveMemoryFlushRelativePathForRun(params: {
    cfg?: OpenClawConfig;
    nowMs?: number;
}): string;
export declare function resolveMemoryFlushPromptForRun(params: {
    prompt: string;
    cfg?: OpenClawConfig;
    nowMs?: number;
}): string;
export type MemoryFlushSettings = {
    enabled: boolean;
    softThresholdTokens: number;
    /**
     * Force a pre-compaction memory flush when the session transcript reaches this
     * size. Set to 0 to disable byte-size based triggering.
     */
    forceFlushTranscriptBytes: number;
    prompt: string;
    systemPrompt: string;
    reserveTokensFloor: number;
};
export declare function resolveMemoryFlushSettings(cfg?: OpenClawConfig): MemoryFlushSettings | null;
export declare function resolveMemoryFlushContextWindowTokens(params: {
    modelId?: string;
    agentCfgContextTokens?: number;
}): number;
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
/**
 * Returns true when a memory flush has already been performed for the current
 * compaction cycle. This prevents repeated flush runs within the same cycle —
 * important for both the token-based and transcript-size–based trigger paths.
 */
export declare function hasAlreadyFlushedForCurrentCompaction(entry: Pick<SessionEntry, "compactionCount" | "memoryFlushCompactionCount">): boolean;
