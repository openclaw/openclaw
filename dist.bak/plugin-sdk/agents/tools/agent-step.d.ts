export declare function readLatestAssistantReply(params: {
    sessionKey: string;
    limit?: number;
}): Promise<string | undefined>;
export declare function runAgentStep(params: {
    sessionKey: string;
    message: string;
    extraSystemPrompt: string;
    timeoutMs: number;
    channel?: string;
    lane?: string;
    sourceSessionKey?: string;
    sourceChannel?: string;
    sourceTool?: string;
}): Promise<string | undefined>;
