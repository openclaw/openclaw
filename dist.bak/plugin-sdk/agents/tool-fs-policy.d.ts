import type { OpenClawConfig } from "../config/config.js";
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
