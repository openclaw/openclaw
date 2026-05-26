export declare const AGENT_CLEANUP_STEP_TIMEOUT_MS = 10000;
export declare const AGENT_CLEANUP_STEP_TIMEOUT_ENV = "OPENCLAW_AGENT_CLEANUP_TIMEOUT_MS";
export declare const TRAJECTORY_FLUSH_TIMEOUT_ENV = "OPENCLAW_TRAJECTORY_FLUSH_TIMEOUT_MS";
export declare const CLEANUP_TIMEOUT_DETAILS_MAX_CHARS = 512;
type AgentCleanupLogger = {
    warn: (message: string) => void;
};
export declare function resolveAgentCleanupStepTimeoutMs(params: {
    step: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
}): number;
export declare function runAgentCleanupStep(params: {
    runId: string;
    sessionId: string;
    step: string;
    cleanup: () => Promise<void>;
    getTimeoutDetails?: () => string | undefined;
    log: AgentCleanupLogger;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
}): Promise<void>;
export {};
