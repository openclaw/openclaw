import type { SubagentRunRecord } from "./subagent-registry.types.js";
export declare const STALE_UNENDED_SUBAGENT_RUN_MS: number;
export declare const RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS: number;
export declare function hasSubagentRunEnded<T extends Pick<SubagentRunRecord, "endedAt">>(entry: T): entry is T & {
    endedAt: number;
};
export declare function isStaleUnendedSubagentRun(entry: Pick<SubagentRunRecord, "createdAt" | "startedAt" | "sessionStartedAt" | "endedAt" | "runTimeoutSeconds">, now?: number): boolean;
export declare function isLiveUnendedSubagentRun(entry: Pick<SubagentRunRecord, "createdAt" | "startedAt" | "sessionStartedAt" | "endedAt" | "runTimeoutSeconds">, now?: number): boolean;
export declare function isRecentlyEndedSubagentRun(entry: Pick<SubagentRunRecord, "endedAt">, now?: number, recentMs?: number): boolean;
export declare function shouldKeepSubagentRunChildLink(entry: Pick<SubagentRunRecord, "createdAt" | "startedAt" | "sessionStartedAt" | "endedAt" | "runTimeoutSeconds">, options?: {
    activeDescendants?: number;
    now?: number;
}): boolean;
