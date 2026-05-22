export type SessionUsageTimePoint = {
    timestamp: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: number;
    cumulativeTokens: number;
    cumulativeCost: number;
};
export type SessionUsageTimeSeries = {
    sessionId?: string;
    points: SessionUsageTimePoint[];
};
