import type { OpenClawConfig } from "../config/types.openclaw.js";
export type ToolFsPolicy = {
    workspaceOnly: boolean;
};
export declare function createToolFsPolicy(params: {
    workspaceOnly?: boolean;
}): ToolFsPolicy;
export declare function resolveToolFsConfig(params: {
    cfg?: OpenClawConfig;
    agentId?: string;
}): {
    workspaceOnly?: boolean;
};
export declare function resolveEffectiveToolFsWorkspaceOnly(params: {
    cfg?: OpenClawConfig;
    agentId?: string;
}): boolean;
export declare function resolveEffectiveToolFsRootExpansionAllowed(params: {
    cfg?: OpenClawConfig;
    agentId?: string;
}): boolean;
