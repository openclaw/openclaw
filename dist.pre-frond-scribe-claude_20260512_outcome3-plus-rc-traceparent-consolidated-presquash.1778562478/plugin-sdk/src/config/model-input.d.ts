import type { AgentModelConfig } from "./types.agents-shared.js";
type AgentModelListLike = {
    primary?: string;
    fallbacks?: string[];
    timeoutMs?: number;
};
export declare function resolveAgentModelPrimaryValue(model?: AgentModelConfig): string | undefined;
export declare function resolveAgentModelFallbackValues(model?: AgentModelConfig): string[];
export declare function resolveAgentModelTimeoutMsValue(model?: AgentModelConfig): number | undefined;
export declare function toAgentModelListLike(model?: AgentModelConfig): AgentModelListLike | undefined;
export {};
