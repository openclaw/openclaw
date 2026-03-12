import type { AgentMessage, StreamFn } from "@mariozechner/pi-agent-core";
export type AnthropicPayloadLogger = {
    enabled: true;
    wrapStreamFn: (streamFn: StreamFn) => StreamFn;
    recordUsage: (messages: AgentMessage[], error?: unknown) => void;
};
export declare function createAnthropicPayloadLogger(params: {
    env?: NodeJS.ProcessEnv;
    runId?: string;
    sessionId?: string;
    sessionKey?: string;
    provider?: string;
    modelId?: string;
    modelApi?: string | null;
    workspaceDir?: string;
}): AnthropicPayloadLogger | null;
