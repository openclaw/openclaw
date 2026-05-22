type AgentTraceBase = {
    runId?: string;
    sessionId?: string;
    sessionKey?: string;
    provider?: string;
    modelId?: string;
    modelApi?: string | null;
    workspaceDir?: string;
};
export declare function buildAgentTraceBase(params: AgentTraceBase): AgentTraceBase;
export {};
