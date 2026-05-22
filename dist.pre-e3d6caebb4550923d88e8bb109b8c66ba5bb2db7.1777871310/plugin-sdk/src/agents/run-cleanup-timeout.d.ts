export declare const AGENT_CLEANUP_STEP_TIMEOUT_MS = 10000;
type AgentCleanupLogger = {
    warn: (message: string) => void;
};
export declare function runAgentCleanupStep(params: {
    runId: string;
    sessionId: string;
    step: string;
    cleanup: () => Promise<void>;
    log: AgentCleanupLogger;
    timeoutMs?: number;
}): Promise<void>;
export {};
