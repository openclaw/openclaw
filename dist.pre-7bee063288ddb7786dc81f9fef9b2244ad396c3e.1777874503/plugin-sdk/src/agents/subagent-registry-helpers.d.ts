import { type SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
export { getSubagentSessionRuntimeMs, getSubagentSessionStartedAt, resolveSubagentSessionStatus, } from "./subagent-session-metrics.js";
export declare const MIN_ANNOUNCE_RETRY_DELAY_MS = 1000;
export declare const MAX_ANNOUNCE_RETRY_COUNT = 3;
export declare const ANNOUNCE_EXPIRY_MS: number;
export declare const ANNOUNCE_COMPLETION_HARD_EXPIRY_MS: number;
type SubagentRunOrphanReason = "missing-session-entry" | "missing-session-id" | "stale-unended-run";
export declare function capFrozenResultText(resultText: string): string;
export declare function resolveAnnounceRetryDelayMs(retryCount: number): number;
export declare function logAnnounceGiveUp(entry: SubagentRunRecord, reason: "retry-limit" | "expiry"): void;
export declare function persistSubagentSessionTiming(entry: SubagentRunRecord): Promise<void>;
export declare function resolveSubagentRunOrphanReason(params: {
    entry: SubagentRunRecord;
    storeCache?: Map<string, Record<string, SessionEntry>>;
    includeStaleUnended?: boolean;
    now?: number;
}): SubagentRunOrphanReason | null;
export declare function safeRemoveAttachmentsDir(entry: SubagentRunRecord): Promise<void>;
export declare function reconcileOrphanedRun(params: {
    runId: string;
    entry: SubagentRunRecord;
    reason: SubagentRunOrphanReason;
    source: "restore" | "resume";
    runs: Map<string, SubagentRunRecord>;
    resumedRuns: Set<string>;
}): boolean;
export declare function reconcileOrphanedRestoredRuns(params: {
    runs: Map<string, SubagentRunRecord>;
    resumedRuns: Set<string>;
}): boolean;
export declare function resolveArchiveAfterMs(cfg?: OpenClawConfig): number | undefined;
