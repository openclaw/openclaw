import type { AgentRuntimePolicyConfig } from "../config/types.agents-shared.js";
type AgentRuntimePolicyContainer = {
    agentRuntime?: AgentRuntimePolicyConfig;
};
export declare function resolveAgentRuntimePolicy(container: AgentRuntimePolicyContainer | undefined): AgentRuntimePolicyConfig | undefined;
export {};
