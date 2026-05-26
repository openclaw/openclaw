import type { AgentToolModelConfig } from "../../config/types.agents-shared.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AuthProfileCredential, AuthProfileStore } from "../auth-profiles/types.js";
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
export declare function hasAuthProfileForProvider(params: {
    provider: string;
    agentDir?: string;
    authStore?: AuthProfileStore;
    includeExternalCli?: boolean;
    type?: AuthProfileCredential["type"];
}): boolean;
export declare function hasProviderAuthForTool(params: {
    provider: string;
    cfg?: OpenClawConfig;
    workspaceDir?: string;
    agentDir?: string;
    authStore?: AuthProfileStore;
}): boolean;
export declare function coerceToolModelConfig(model?: AgentToolModelConfig): ToolModelConfig;
export declare function buildToolModelConfigFromCandidates(params: {
    explicit: ToolModelConfig;
    cfg?: OpenClawConfig;
    workspaceDir?: string;
    agentDir?: string;
    authStore?: AuthProfileStore;
    candidates: Array<string | null | undefined>;
    isProviderConfigured?: (provider: string) => boolean;
}): ToolModelConfig | null;
