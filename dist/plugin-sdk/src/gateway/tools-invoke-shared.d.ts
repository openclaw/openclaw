import type { OpenClawConfig } from "../config/types.openclaw.js";
export type ToolsInvokeInput = {
    tool?: unknown;
    name?: unknown;
    action?: unknown;
    args?: unknown;
    sessionKey?: unknown;
    agentId?: unknown;
    idempotencyKey?: unknown;
    dryRun?: unknown;
};
type ToolsInvokeErrorType = "invalid_request" | "not_found" | "tool_call_blocked" | "tool_error";
type ToolsInvokeOutcome = {
    ok: true;
    status: 200;
    toolName: string;
    source: "core" | "plugin" | "channel";
    result: unknown;
} | {
    ok: false;
    status: 400 | 403 | 404 | 500;
    toolName: string;
    error: {
        type: ToolsInvokeErrorType;
        message: string;
        requiresApproval?: boolean;
    };
};
export declare function invokeGatewayTool(params: {
    cfg: OpenClawConfig;
    input: ToolsInvokeInput;
    messageChannel?: string;
    accountId?: string;
    agentTo?: string;
    agentThreadId?: string;
    senderIsOwner?: boolean;
    toolCallIdPrefix: string;
    approvalMode?: "request" | "report";
}): Promise<ToolsInvokeOutcome>;
export {};
