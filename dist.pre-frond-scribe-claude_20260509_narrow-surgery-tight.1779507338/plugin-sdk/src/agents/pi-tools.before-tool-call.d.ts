import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ToolLoopDetectionConfig } from "../config/types.tools.js";
import { type DiagnosticTraceContext } from "../infra/diagnostic-trace-context.js";
import { type PluginHookToolInputKind, type PluginHookToolKind } from "../plugins/types.js";
import { isPlainObject } from "../utils.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import type { AnyAgentTool } from "./tools/common.js";
export type ToolOutcomeObservation = {
    toolName: string;
    argsHash: string;
    resultHash: string;
};
export type ToolOutcomeObserver = (observation: ToolOutcomeObservation) => void;
export declare function isAbortSignalCancellation(err: unknown, signal?: AbortSignal): boolean;
export type HookContext = {
    agentId?: string;
    config?: OpenClawConfig;
    /** Tool execution cwd for host-derived path facts. */
    cwd?: string;
    sessionKey?: string;
    /** Ephemeral session UUID — regenerated on /new and /reset. */
    sessionId?: string;
    runId?: string;
    trace?: DiagnosticTraceContext;
    channelId?: string;
    loopDetection?: ToolLoopDetectionConfig;
    onToolOutcome?: ToolOutcomeObserver;
    sandbox?: {
        root: string;
        bridge: SandboxFsBridge;
    };
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
export declare function hasBeforeToolCallPolicy(): boolean;
/**
 * Error used when before_tool_call intentionally vetoes a tool call.
 */
export declare class BeforeToolCallBlockedError extends Error {
    readonly reason: string;
    constructor(reason: string);
}
export declare function recordAdjustedParamsForToolCall(toolCallId: string | undefined, params: unknown, runId?: string): void;
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
    toolKind?: PluginHookToolKind;
    toolInputKind?: PluginHookToolInputKind;
    toolCallId?: string;
    ctx?: HookContext;
    signal?: AbortSignal;
    approvalMode?: "request" | "report";
}): Promise<HookOutcome>;
export declare function wrapToolWithBeforeToolCallHook(tool: AnyAgentTool, ctx?: HookContext, options?: {
    emitDiagnostics?: boolean;
}): AnyAgentTool;
export declare function isToolWrappedWithBeforeToolCallHook(tool: AnyAgentTool): boolean;
export declare function setBeforeToolCallDiagnosticsEnabled(tool: AnyAgentTool, enabled: boolean): void;
export declare function copyBeforeToolCallHookMarker(source: AnyAgentTool, target: AnyAgentTool): void;
export declare function consumeAdjustedParamsForToolCall(toolCallId: string, runId?: string): unknown;
export declare const testing: {
    BEFORE_TOOL_CALL_DIAGNOSTIC_OPTIONS: symbol;
    BEFORE_TOOL_CALL_WRAPPED: symbol;
    buildAdjustedParamsKey: typeof buildAdjustedParamsKey;
    adjustedParamsByToolCallId: Map<string, unknown>;
    runBeforeToolCallHook: typeof runBeforeToolCallHook;
    mergeParamsWithApprovalOverrides: typeof mergeParamsWithApprovalOverrides;
    isPlainObject: typeof isPlainObject;
};
export { testing as __testing };
