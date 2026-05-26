import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CostUsageSummary, DiscoveredSession, SessionCostSummary, SessionLogEntry, SessionUsageTimeSeries, UsageCacheStatus } from "./session-cost-usage.types.js";
export type { CostUsageSummary, CostUsageTotals, DiscoveredSession, SessionCostSummary, SessionDailyLatency, SessionDailyModelUsage, SessionLatencyStats, SessionMessageCounts, SessionModelUsage, SessionToolUsage, UsageCacheStatus, } from "./session-cost-usage.types.js";
type UsageCostRefreshResult = "refreshed" | "busy";
export declare function resolveExistingUsageSessionFile(params: {
    sessionId?: string;
    sessionEntry?: SessionEntry;
    sessionFile?: string;
    agentId?: string;
}): string | undefined;
export declare function loadCostUsageSummary(params?: {
    startMs?: number;
    endMs?: number;
    /** @deprecated Use startMs/endMs. */
    days?: number;
    config?: OpenClawConfig;
    agentId?: string;
}): Promise<CostUsageSummary>;
export declare function refreshCostUsageCache(params?: {
    config?: OpenClawConfig;
    agentId?: string;
    maxFiles?: number;
    sessionFiles?: string[];
    startMs?: number;
}): Promise<UsageCostRefreshResult>;
export declare function loadCostUsageSummaryFromCache(params: {
    startMs: number;
    endMs: number;
    config?: OpenClawConfig;
    agentId?: string;
    requestRefresh?: boolean;
    refreshMode?: "background" | "sync-when-empty";
}): Promise<CostUsageSummary>;
export declare function loadSessionCostSummaryFromCache(params: {
    sessionId?: string;
    sessionEntry?: SessionEntry;
    sessionFile: string;
    config?: OpenClawConfig;
    agentId?: string;
    startMs?: number;
    endMs?: number;
    requestRefresh?: boolean;
    refreshMode?: "background" | "sync-when-empty";
}): Promise<{
    summary: SessionCostSummary | null;
    cacheStatus: UsageCacheStatus;
}>;
export declare function requestCostUsageCacheRefresh(params?: {
    config?: OpenClawConfig;
    agentId?: string;
    sessionFiles?: string[];
}): void;
/**
 * Scan all transcript files to discover sessions not in the session store.
 * Returns basic metadata for each discovered session.
 */
export declare function discoverAllSessions(params?: {
    agentId?: string;
    startMs?: number;
    endMs?: number;
    includeFirstUserMessage?: boolean;
}): Promise<DiscoveredSession[]>;
export declare function loadSessionCostSummary(params: {
    sessionId?: string;
    sessionEntry?: SessionEntry;
    sessionFile?: string;
    config?: OpenClawConfig;
    agentId?: string;
    startMs?: number;
    endMs?: number;
}): Promise<SessionCostSummary | null>;
export declare function loadSessionUsageTimeSeries(params: {
    sessionId?: string;
    sessionEntry?: SessionEntry;
    sessionFile?: string;
    config?: OpenClawConfig;
    agentId?: string;
    maxPoints?: number;
}): Promise<SessionUsageTimeSeries | null>;
export declare function loadSessionLogs(params: {
    sessionId?: string;
    sessionEntry?: SessionEntry;
    sessionFile?: string;
    config?: OpenClawConfig;
    agentId?: string;
    limit?: number;
}): Promise<SessionLogEntry[] | null>;
