import type { ExecApprovalRequest, PluginApprovalRequest } from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
export type SlackApprovalKind = "exec" | "plugin";
export type SlackNativeApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
export declare function resolveSlackApprovalKind(request: SlackNativeApprovalRequest): SlackApprovalKind;
export declare function isSlackNativeApprovalClientEnabled(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    approvalKind: SlackApprovalKind;
}): boolean;
export declare function isSlackAnyNativeApprovalClientEnabled(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
}): boolean;
export declare function shouldHandleSlackNativeApprovalRequest(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    approvalKind?: SlackApprovalKind;
    request: SlackNativeApprovalRequest;
}): boolean;
