type LatencyTotalsLike = {
    count: number;
    sum: number;
    min: number;
    max: number;
    p95Max: number;
};
type DailyLatencyLike = {
    date: string;
    count: number;
    sum: number;
    min: number;
    max: number;
    p95Max: number;
};
type DailyLike = {
    date: string;
};
type LatencyLike = {
    count: number;
    avgMs: number;
    minMs: number;
    maxMs: number;
    p95Ms: number;
};
type DailyLatencyInput = LatencyLike & {
    date: string;
};
export declare function mergeUsageLatency(totals: LatencyTotalsLike, latency: LatencyLike | undefined): void;
export declare function mergeUsageDailyLatency(dailyLatencyMap: Map<string, DailyLatencyLike>, dailyLatency?: DailyLatencyInput[] | null): void;
export declare function buildUsageAggregateTail<TTotals extends {
    totalCost: number;
}, TDaily extends DailyLike, TModelDaily extends {
    date: string;
    cost: number;
}>(params: {
    byChannelMap: Map<string, TTotals>;
    latencyTotals: LatencyTotalsLike;
    dailyLatencyMap: Map<string, DailyLatencyLike>;
    modelDailyMap: Map<string, TModelDaily>;
    dailyMap: Map<string, TDaily>;
}): {
    byChannel: {
        channel: string;
        totals: TTotals;
    }[];
    latency: {
        count: number;
        avgMs: number;
        minMs: number;
        maxMs: number;
        p95Ms: number;
    } | undefined;
    dailyLatency: {
        date: string;
        count: number;
        avgMs: number;
        minMs: number;
        maxMs: number;
        p95Ms: number;
    }[];
    modelDaily: TModelDaily[];
    daily: TDaily[];
};
export {};
