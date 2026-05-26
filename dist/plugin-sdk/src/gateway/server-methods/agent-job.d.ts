type AgentRunSnapshot = {
    runId: string;
    status: "ok" | "error" | "timeout";
    startedAt?: number;
    endedAt?: number;
    error?: string;
    stopReason?: string;
    livenessState?: string;
    yielded?: boolean;
    ts: number;
};
export declare function waitForAgentJob(params: {
    runId: string;
    timeoutMs: number;
    signal?: AbortSignal;
    ignoreCachedSnapshot?: boolean;
}): Promise<AgentRunSnapshot | null>;
export declare const __testing: {
    getWaiterCount(runId?: string): number;
    resetWaiters(): void;
};
export {};
