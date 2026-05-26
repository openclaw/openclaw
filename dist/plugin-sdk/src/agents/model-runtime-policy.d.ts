import type { AgentRuntimePolicyConfig } from "../config/types.agents-shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
export type ModelRuntimePolicySource = "model" | "provider";
export type ResolvedModelRuntimePolicy = {
    policy?: AgentRuntimePolicyConfig;
    source?: ModelRuntimePolicySource;
};
export declare function resolveModelRuntimePolicy(params: {
    config?: OpenClawConfig;
    provider?: string;
    modelId?: string;
    agentId?: string;
    sessionKey?: string;
}): ResolvedModelRuntimePolicy;
