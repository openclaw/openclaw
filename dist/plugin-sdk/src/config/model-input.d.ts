import type { AgentModelConfig, AgentToolModelConfig } from "./types.agents-shared.js";
type AgentModelListLike = {
    primary?: string;
    fallbacks?: string[];
};
type AgentModelInput = AgentModelConfig | AgentToolModelConfig;
export declare function resolveAgentModelPrimaryValue(model?: AgentModelInput): string | undefined;
export declare function resolveAgentModelFallbackValues(model?: AgentModelInput): string[];
export declare function resolveAgentModelTimeoutMsValue(model?: AgentToolModelConfig): number | undefined;
export declare function toAgentModelListLike(model?: AgentModelConfig): AgentModelListLike | undefined;
export declare function normalizeAgentModelRefForConfig(model: string): string;
export declare function normalizeAgentModelMapForConfig<T extends Record<string, unknown>>(models: T): T;
export {};
