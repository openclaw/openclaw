import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CostUsageSummary } from "../../infra/session-cost-usage.js";
import { type DiscoveredSession } from "../../infra/session-cost-usage.js";
import type { SessionUsageEntry, SessionsUsageAggregates, SessionsUsageResult } from "../../shared/usage-types.js";
import type { GatewayRequestHandlers } from "./types.js";
type DateRange = {
    startMs: number;
    endMs: number;
};
type DateInterpretation = {
    mode: "utc" | "gateway";
} | {
    mode: "specific";
    utcOffsetMinutes: number;
};
type CostUsageCacheEntry = {
    summary?: CostUsageSummary;
    updatedAt?: number;
    inFlight?: Promise<CostUsageSummary>;
};
type DiscoveredSessionWithAgent = DiscoveredSession & {
    agentId: string;
};
declare function discoverAllSessionsForUsage(params: {
    config: OpenClawConfig;
    agentId?: string;
    startMs: number;
    endMs: number;
}): Promise<DiscoveredSessionWithAgent[]>;
declare function loadCostUsageSummaryCached(params: {
    startMs: number;
    endMs: number;
    config: OpenClawConfig;
}): Promise<CostUsageSummary>;
export declare const testApi: {
    parseDateParts: (raw: unknown) => {
        year: number;
        monthIndex: number;
        day: number;
    } | undefined;
    parseUtcOffsetToMinutes: (raw: unknown) => number | undefined;
    resolveDateInterpretation: (params: {
        mode?: unknown;
        utcOffset?: unknown;
    }) => DateInterpretation;
    parseDateToMs: (raw: unknown, interpretation?: DateInterpretation) => number | undefined;
    getTodayStartMs: (now: Date, interpretation: DateInterpretation) => number;
    parseDays: (raw: unknown) => number | undefined;
    parseDateRange: (params: {
        startDate?: unknown;
        endDate?: unknown;
        days?: unknown;
        range?: unknown;
        mode?: unknown;
        utcOffset?: unknown;
    }) => DateRange;
    discoverAllSessionsForUsage: typeof discoverAllSessionsForUsage;
    loadCostUsageSummaryCached: typeof loadCostUsageSummaryCached;
    costUsageCache: Map<string, CostUsageCacheEntry>;
};
export { testApi as __test };
export type { SessionUsageEntry, SessionsUsageAggregates, SessionsUsageResult };
export declare const usageHandlers: GatewayRequestHandlers;
