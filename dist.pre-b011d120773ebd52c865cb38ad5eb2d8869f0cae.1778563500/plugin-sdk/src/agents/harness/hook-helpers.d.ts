import type { AgentMessage } from "@mariozechner/pi-agent-core";
export declare function runAgentHarnessAfterToolCallHook(params: {
    toolName: string;
    toolCallId: string;
    runId?: string;
    agentId?: string;
    sessionId?: string;
    sessionKey?: string;
    startArgs: Record<string, unknown>;
    result?: unknown;
    error?: string;
    startedAt?: number;
}): Promise<void>;
export declare function runAgentHarnessBeforeMessageWriteHook(params: {
    message: AgentMessage;
    agentId?: string;
    sessionKey?: string;
}): AgentMessage | null;
