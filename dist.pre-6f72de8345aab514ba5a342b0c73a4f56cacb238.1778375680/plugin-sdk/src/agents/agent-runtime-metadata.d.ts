import type { OpenClawConfig } from "../config/types.openclaw.js";
type AgentRuntimeMetadata = {
    id: string;
    source: "implicit" | "model" | "provider";
};
export declare function resolveAgentRuntimeMetadata(_cfg: OpenClawConfig, _agentId: string, _env?: NodeJS.ProcessEnv): AgentRuntimeMetadata;
export declare function resolveModelAgentRuntimeMetadata(params: {
    cfg: OpenClawConfig;
    agentId: string;
    provider?: string;
    model?: string;
    sessionKey?: string;
}): AgentRuntimeMetadata;
export {};
