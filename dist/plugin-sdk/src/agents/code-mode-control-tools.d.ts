import type { AnyAgentTool } from "./tools/common.js";
export declare const CODE_MODE_EXEC_TOOL_NAME = "exec";
export declare const CODE_MODE_WAIT_TOOL_NAME = "wait";
export declare const CODE_MODE_EXEC_TOOL_KIND = "code_mode_exec";
export type CodeModeExecToolKind = typeof CODE_MODE_EXEC_TOOL_KIND;
export type CodeModeExecToolInputKind = "javascript" | "typescript";
export type CodeModeExecHookMetadata = {
    toolKind: CodeModeExecToolKind;
    toolInputKind?: CodeModeExecToolInputKind;
};
export declare function markCodeModeControlTool<T extends AnyAgentTool>(tool: T): T;
export declare function isCodeModeControlTool(tool: AnyAgentTool): boolean;
export declare function getCodeModeExecBeforeHookMetadata(params: {
    tool: AnyAgentTool;
    params: unknown;
}): CodeModeExecHookMetadata | undefined;
export declare function getCodeModeExecBeforeHookMetadataForToolKind(params: {
    toolKind: unknown;
    params: unknown;
}): CodeModeExecHookMetadata | undefined;
export declare function normalizeCodeModeExecBeforeHookParams(params: {
    tool: AnyAgentTool;
    params: unknown;
}): unknown;
export declare function normalizeCodeModeExecBeforeHookParamsForToolKind(params: {
    toolKind: unknown;
    params: unknown;
}): unknown;
export declare function reconcileCodeModeExecBeforeHookParams(params: {
    tool: AnyAgentTool;
    originalParams: unknown;
    hookParams: unknown;
    adjustedParams: unknown;
}): unknown;
