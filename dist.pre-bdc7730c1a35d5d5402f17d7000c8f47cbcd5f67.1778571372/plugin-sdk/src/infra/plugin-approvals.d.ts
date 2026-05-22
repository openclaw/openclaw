import type { ExecApprovalDecision } from "./exec-approvals.js";
export type PluginApprovalRequestPayload = {
    pluginId?: string | null;
    title: string;
    description: string;
    severity?: "info" | "warning" | "critical" | null;
    toolName?: string | null;
    toolCallId?: string | null;
    allowedDecisions?: readonly ExecApprovalDecision[] | null;
    agentId?: string | null;
    sessionKey?: string | null;
    turnSourceChannel?: string | null;
    turnSourceTo?: string | null;
    turnSourceAccountId?: string | null;
    turnSourceThreadId?: string | number | null;
};
export type PluginApprovalRequest = {
    id: string;
    request: PluginApprovalRequestPayload;
    createdAtMs: number;
    expiresAtMs: number;
};
export type PluginApprovalResolved = {
    id: string;
    decision: ExecApprovalDecision;
    resolvedBy?: string | null;
    ts: number;
    request?: PluginApprovalRequestPayload;
};
export declare const DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS = 120000;
export declare const MAX_PLUGIN_APPROVAL_TIMEOUT_MS = 600000;
export declare const PLUGIN_APPROVAL_TITLE_MAX_LENGTH = 80;
export declare const PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH = 256;
export declare const DEFAULT_PLUGIN_APPROVAL_DECISIONS: readonly ["allow-once", "allow-always", "deny"];
export declare function approvalDecisionLabel(decision: ExecApprovalDecision): string;
export declare function resolvePluginApprovalRequestAllowedDecisions(params?: {
    allowedDecisions?: readonly ExecApprovalDecision[] | readonly string[] | null;
}): readonly ExecApprovalDecision[];
export declare function buildPluginApprovalRequestMessage(request: PluginApprovalRequest, nowMsValue: number): string;
export declare function buildPluginApprovalResolvedMessage(resolved: PluginApprovalResolved): string;
export declare function buildPluginApprovalExpiredMessage(request: PluginApprovalRequest): string;
