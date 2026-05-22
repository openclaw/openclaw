import type { IdentityConfig } from "../../config/types.base.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
export type AgentDeleteMutationResult = {
    workspaceDir: string;
    agentDir: string;
    sessionsDir: string;
    removedBindings: number;
};
export declare class AgentConfigPreconditionError extends Error {
    readonly kind: "already-exists" | "not-found";
    readonly agentId: string;
    constructor(kind: "already-exists" | "not-found", agentId: string);
}
export declare function isConfiguredAgent(cfg: OpenClawConfig, agentId: string): boolean;
export declare function createAgentConfigEntry(params: {
    agentId: string;
    name: string;
    workspace: string;
    model?: string;
    identity?: IdentityConfig;
    agentDir: string;
}): Promise<void>;
export declare function updateAgentConfigEntry(params: {
    agentId: string;
    name?: string;
    workspace?: string;
    model?: string;
    identity?: IdentityConfig;
}): Promise<void>;
export declare function deleteAgentConfigEntry(params: {
    agentId: string;
}): Promise<{
    nextConfig: OpenClawConfig;
    result: AgentDeleteMutationResult | undefined;
}>;
