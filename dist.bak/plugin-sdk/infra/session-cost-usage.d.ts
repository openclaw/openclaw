import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { CostUsageSummary, DiscoveredSession, SessionCostSummary, SessionLogEntry, SessionUsageTimeSeries } from "./session-cost-usage.types.js";
export type { CostUsageDailyEntry, CostUsageSummary, CostUsageTotals, DiscoveredSession, SessionCostSummary, SessionDailyLatency, SessionDailyMessageCounts, SessionDailyModelUsage, SessionDailyUsage, SessionLatencyStats, SessionLogEntry, SessionMessageCounts, SessionModelUsage, SessionToolUsage, SessionUsageTimePoint, SessionUsageTimeSeries, } from "./session-cost-usage.types.js";
export declare function loadCostUsageSummary(params?: {
    startMs?: number;
    endMs?: number;
    days?: number;
    config?: OpenClawConfig;
    agentId?: string;
}): Promise<CostUsageSummary>;
/**
 * Scan all transcript files to discover sessions not in the session store.
 * Returns basic metadata for each discovered session.
 */
export declare function discoverAllSessions(params?: {
    agentId?: string;
    startMs?: number;
    endMs?: number;
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
