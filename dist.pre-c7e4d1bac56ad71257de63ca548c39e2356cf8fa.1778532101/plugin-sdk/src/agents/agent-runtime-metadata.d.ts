import type { OpenClawConfig } from "../config/types.openclaw.js";
type AgentRuntimeMetadata = {
    id: string;
    source: "env" | "agent" | "defaults" | "implicit";
};
export declare function resolveAgentRuntimeMetadata(cfg: OpenClawConfig, agentId: string, env?: NodeJS.ProcessEnv): AgentRuntimeMetadata;
export {};
