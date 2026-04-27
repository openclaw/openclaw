import type { ImageSanitizationLimits } from "./image-sanitization.js";
import type { AnyAgentTool } from "./pi-tools.types.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
export { REQUIRED_PARAM_GROUPS, assertRequiredParams, getToolParamsRecord, wrapToolParamValidation, } from "./pi-tools.params.js";
type OpenClawReadToolOptions = {
    modelContextWindowTokens?: number;
    imageSanitization?: ImageSanitizationLimits;
};
export declare function wrapToolWorkspaceRootGuard(tool: AnyAgentTool, root: string): AnyAgentTool;
export declare function resolveToolPathAgainstWorkspaceRoot(params: {
    filePath: string;
    root: string;
    containerWorkdir?: string;
}): string;
type MemoryFlushAppendOnlyWriteOptions = {
    root: string;
    relativePath: string;
    containerWorkdir?: string;
    sandbox?: {
        root: string;
        bridge: SandboxFsBridge;
    };
};
export declare function wrapToolMemoryFlushAppendOnlyWrite(tool: AnyAgentTool, options: MemoryFlushAppendOnlyWriteOptions): AnyAgentTool;
export declare function wrapToolWorkspaceRootGuardWithOptions(tool: AnyAgentTool, root: string, options?: {
    containerWorkdir?: string;
    pathParamKeys?: readonly string[];
    normalizeGuardedPathParams?: boolean;
}): AnyAgentTool;
type SandboxToolParams = {
    root: string;
    bridge: SandboxFsBridge;
    modelContextWindowTokens?: number;
    imageSanitization?: ImageSanitizationLimits;
};
export declare function createSandboxedReadTool(params: SandboxToolParams): AnyAgentTool;
export declare function createSandboxedWriteTool(params: SandboxToolParams): AnyAgentTool;
export declare function createSandboxedEditTool(params: SandboxToolParams): AnyAgentTool;
export declare function createHostWorkspaceWriteTool(root: string, options?: {
    workspaceOnly?: boolean;
}): AnyAgentTool;
export declare function createHostWorkspaceEditTool(root: string, options?: {
    workspaceOnly?: boolean;
}): AnyAgentTool;
export declare function createOpenClawReadTool(base: AnyAgentTool, options?: OpenClawReadToolOptions): AnyAgentTool;
