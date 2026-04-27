import type { ToolLoopDetectionConfig } from "../config/types.tools.js";
import { type DiagnosticTraceContext } from "../infra/diagnostic-trace-context.js";
import { isPlainObject } from "../utils.js";
import type { AnyAgentTool } from "./tools/common.js";
export type HookContext = {
    agentId?: string;
    sessionKey?: string;
    /** Ephemeral session UUID — regenerated on /new and /reset. */
    sessionId?: string;
    runId?: string;
    trace?: DiagnosticTraceContext;
    loopDetection?: ToolLoopDetectionConfig;
};
type HookOutcome = {
    blocked: true;
    reason: string;
} | {
    blocked: false;
    params: unknown;
};
declare function buildAdjustedParamsKey(params: {
    runId?: string;
    toolCallId: string;
}): string;
declare function mergeParamsWithApprovalOverrides(originalParams: unknown, approvalParams?: unknown): unknown;
export declare function runBeforeToolCallHook(args: {
    toolName: string;
    params: unknown;
    toolCallId?: string;
    ctx?: HookContext;
    signal?: AbortSignal;
}): Promise<HookOutcome>;
export declare function wrapToolWithBeforeToolCallHook(tool: AnyAgentTool, ctx?: HookContext): AnyAgentTool;
export declare function isToolWrappedWithBeforeToolCallHook(tool: AnyAgentTool): boolean;
export declare function consumeAdjustedParamsForToolCall(toolCallId: string, runId?: string): unknown;
export declare const __testing: {
    BEFORE_TOOL_CALL_WRAPPED: symbol;
    buildAdjustedParamsKey: typeof buildAdjustedParamsKey;
    adjustedParamsByToolCallId: Map<string, unknown>;
    runBeforeToolCallHook: typeof runBeforeToolCallHook;
    mergeParamsWithApprovalOverrides: typeof mergeParamsWithApprovalOverrides;
    isPlainObject: typeof isPlainObject;
};
export {};
