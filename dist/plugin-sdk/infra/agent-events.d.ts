import type { VerboseLevel } from "../auto-reply/thinking.js";
export type AgentEventStream = "lifecycle" | "tool" | "assistant" | "error" | (string & {});
export type AgentEventPayload = {
    runId: string;
    seq: number;
    stream: AgentEventStream;
    ts: number;
    data: Record<string, unknown>;
    sessionKey?: string;
};
export type AgentRunContext = {
    sessionKey?: string;
    verboseLevel?: VerboseLevel;
    isHeartbeat?: boolean;
};
export declare function registerAgentRunContext(runId: string, context: AgentRunContext): void;
export declare function getAgentRunContext(runId: string): AgentRunContext | undefined;
export declare function clearAgentRunContext(runId: string): void;
export declare function resetAgentRunContextForTest(): void;
export declare function emitAgentEvent(event: Omit<AgentEventPayload, "seq" | "ts">): void;
export declare function onAgentEvent(listener: (evt: AgentEventPayload) => void): () => boolean;
