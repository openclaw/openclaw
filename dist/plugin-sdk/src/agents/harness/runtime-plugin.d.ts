import type { OpenClawConfig } from "../../config/types.openclaw.js";
export declare function ensureSelectedAgentHarnessPlugin(params: {
    provider: string;
    modelId: string;
    config?: OpenClawConfig;
    agentId?: string;
    sessionKey?: string;
    workspaceDir: string;
}): Promise<void>;
