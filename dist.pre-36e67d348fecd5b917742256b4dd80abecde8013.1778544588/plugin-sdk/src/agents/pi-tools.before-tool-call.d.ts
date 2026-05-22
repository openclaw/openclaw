import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ToolLoopDetectionConfig } from "../config/types.tools.js";
import { type DiagnosticTraceContext } from "../infra/diagnostic-trace-context.js";
import { isPlainObject } from "../utils.js";
import type { AnyAgentTool } from "./tools/common.js";
export type ToolOutcomeObservation = {
    toolName: string;
    argsHash: string;
    resultHash: string;
};
export type ToolOutcomeObserver = (observation: ToolOutcomeObservation) => void;
export type HookContext = {
    agentId?: string;
    config?: OpenClawConfig;
    sessionKey?: string;
    /** Ephemeral session UUID — regenerated on /new and /reset. */
    sessionId?: string;
    runId?: string;
    trace?: DiagnosticTraceContext;
    loopDetection?: ToolLoopDetectionConfig;
    onToolOutcome?: ToolOutcomeObserver;
};
type HookBlockedKind = "veto" | "failure";
type HookBlockedReason = "plugin-before-tool-call" | "plugin-approval" | "tool-loop";
type HookOutcome = {
    blocked: true;
    kind?: HookBlockedKind;
    deniedReason?: HookBlockedReason;
    reason: string;
    params?: unknown;
} | {
    blocked: false;
    params: unknown;
};
/**
 * Error used when before_tool_call intentionally vetoes a tool call.
 */
export declare class BeforeToolCallBlockedError extends Error {
    readonly reason: string;
    constructor(reason: string);
}
/**
 * Returns true when an error represents an intentional before_tool_call veto.
 */
export declare function isBeforeToolCallBlockedError(err: unknown): err is BeforeToolCallBlockedError;
declare function buildAdjustedParamsKey(params: {
    runId?: string;
    toolCallId: string;
}): string;
declare function mergeParamsWithApprovalOverrides(originalParams: unknown, approvalParams?: unknown): unknown;
export declare function buildBlockedToolResult(params: {
    reason: string;
    deniedReason?: HookBlockedReason;
}): {
    content: {
        type: "text";
        text: string;
    }[];
    details: {
        status: string;
        deniedReason: HookBlockedReason;
        reason: string;
    };
};
export declare function runBeforeToolCallHook(args: {
    toolName: string;
    params: unknown;
    toolCallId?: string;
    ctx?: HookContext;
    signal?: AbortSignal;
    approvalMode?: "request" | "report";
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
