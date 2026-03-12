import type { OpenClawConfig } from "../config/config.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";
export declare function applyBootstrapHookOverrides(params: {
    files: WorkspaceBootstrapFile[];
    workspaceDir: string;
    config?: OpenClawConfig;
    sessionKey?: string;
    sessionId?: string;
    agentId?: string;
}): Promise<WorkspaceBootstrapFile[]>;
