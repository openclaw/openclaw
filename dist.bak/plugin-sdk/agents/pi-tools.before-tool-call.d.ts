import type { ToolLoopDetectionConfig } from "../config/types.tools.js";
import { isPlainObject } from "../utils.js";
import type { AnyAgentTool } from "./tools/common.js";
export type HookContext = {
    agentId?: string;
    sessionKey?: string;
    loopDetection?: ToolLoopDetectionConfig;
};
type HookOutcome = {
    blocked: true;
    reason: string;
} | {
    blocked: false;
    params: unknown;
};
export declare function runBeforeToolCallHook(args: {
    toolName: string;
    params: unknown;
    toolCallId?: string;
    ctx?: HookContext;
}): Promise<HookOutcome>;
export declare function wrapToolWithBeforeToolCallHook(tool: AnyAgentTool, ctx?: HookContext): AnyAgentTool;
export declare function isToolWrappedWithBeforeToolCallHook(tool: AnyAgentTool): boolean;
export declare function consumeAdjustedParamsForToolCall(toolCallId: string): unknown;
export declare const __testing: {
    BEFORE_TOOL_CALL_WRAPPED: symbol;
    adjustedParamsByToolCallId: Map<string, unknown>;
    runBeforeToolCallHook: typeof runBeforeToolCallHook;
    isPlainObject: typeof isPlainObject;
};
export {};
