import { type AgentRunTimeoutPhase } from "../../agents/run-timeout-attribution.js";
type AgentRunSnapshot = {
    runId: string;
    status: "ok" | "error" | "timeout";
    startedAt?: number;
    endedAt?: number;
    error?: string;
    stopReason?: string;
    livenessState?: string;
    yielded?: boolean;
    timeoutPhase?: AgentRunTimeoutPhase;
    providerStarted?: boolean;
    ts: number;
};
export declare function waitForAgentJob(params: {
    runId: string;
    timeoutMs: number;
    signal?: AbortSignal;
    ignoreCachedSnapshot?: boolean;
}): Promise<AgentRunSnapshot | null>;
export declare const testing: {
    getWaiterCount(runId?: string): number;
    resetWaiters(): void;
};
export { testing as __testing };
