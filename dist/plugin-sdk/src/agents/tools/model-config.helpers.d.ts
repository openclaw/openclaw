import type { AgentModelConfig } from "../../config/types.agents-shared.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
export type ToolModelConfig = {
    primary?: string;
    fallbacks?: string[];
    timeoutMs?: number;
};
export declare function hasToolModelConfig(model: ToolModelConfig | undefined): boolean;
export declare function resolveDefaultModelRef(cfg?: OpenClawConfig): {
    provider: string;
    model: string;
};
export declare function hasAuthForProvider(params: {
    provider: string;
    agentDir?: string;
    authStore?: AuthProfileStore;
}): boolean;
export declare function coerceToolModelConfig(model?: AgentModelConfig): ToolModelConfig;
export declare function buildToolModelConfigFromCandidates(params: {
    explicit: ToolModelConfig;
    agentDir?: string;
    authStore?: AuthProfileStore;
    candidates: Array<string | null | undefined>;
    isProviderConfigured?: (provider: string) => boolean;
}): ToolModelConfig | null;
