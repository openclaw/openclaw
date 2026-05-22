import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { type ExecApprovalInitiatingSurfaceState } from "../infra/exec-approval-surface.js";
import { resolveExecApprovals, type ExecAsk, type ExecApprovalDecision, type ExecSecurity } from "../infra/exec-approvals.js";
import { logWarn } from "../logger.js";
import { sendExecApprovalFollowup } from "./bash-tools.exec-approval-followup.js";
import { type ExecApprovalRegistration } from "./bash-tools.exec-approval-request.js";
import type { ExecToolDetails } from "./bash-tools.exec-types.js";
type ResolvedExecApprovals = ReturnType<typeof resolveExecApprovals>;
export declare const MAX_EXEC_APPROVAL_FOLLOWUP_FAILURE_LOG_KEYS = 256;
export type ExecHostApprovalContext = {
    approvals: ResolvedExecApprovals;
    hostSecurity: ExecSecurity;
    hostAsk: ExecAsk;
    askFallback: ResolvedExecApprovals["agent"]["askFallback"];
};
export type ExecApprovalPendingState = {
    warningText: string;
    expiresAtMs: number;
    preResolvedDecision: string | null | undefined;
};
export type ExecApprovalRequestState = ExecApprovalPendingState & {
    noticeSeconds: number;
};
export type ExecApprovalUnavailableReason = "no-approval-route" | "initiating-platform-disabled" | "initiating-platform-unsupported";
export type RegisteredExecApprovalRequestContext = {
    approvalId: string;
    approvalSlug: string;
    warningText: string;
    expiresAtMs: number;
    preResolvedDecision: string | null | undefined;
    initiatingSurface: ExecApprovalInitiatingSurfaceState;
    sentApproverDms: boolean;
    unavailableReason: ExecApprovalUnavailableReason | null;
};
export type ExecApprovalFollowupTarget = {
    approvalId: string;
    sessionKey?: string;
    turnSourceChannel?: string;
    turnSourceTo?: string;
    turnSourceAccountId?: string;
    turnSourceThreadId?: string | number;
    direct?: boolean;
};
export type ExecApprovalFollowupResultDeps = {
    sendExecApprovalFollowup?: typeof sendExecApprovalFollowup;
    logWarn?: typeof logWarn;
};
export type DefaultExecApprovalRequestArgs = {
    warnings: string[];
    approvalRunningNoticeMs: number;
    createApprovalSlug: (approvalId: string) => string;
    turnSourceChannel?: string;
    turnSourceAccountId?: string;
};
export declare function createExecApprovalPendingState(params: {
    warnings: string[];
    timeoutMs: number;
}): ExecApprovalPendingState;
export declare function createExecApprovalRequestState(params: {
    warnings: string[];
    timeoutMs: number;
    approvalRunningNoticeMs: number;
}): ExecApprovalRequestState;
export declare function createExecApprovalRequestContext(params: {
    warnings: string[];
    timeoutMs: number;
    approvalRunningNoticeMs: number;
    createApprovalSlug: (approvalId: string) => string;
}): ExecApprovalRequestState & {
    approvalId: string;
    approvalSlug: string;
    contextKey: string;
};
export declare function createDefaultExecApprovalRequestContext(params: {
    warnings: string[];
    approvalRunningNoticeMs: number;
    createApprovalSlug: (approvalId: string) => string;
}): ExecApprovalPendingState & {
    noticeSeconds: number;
} & {
    approvalId: string;
    approvalSlug: string;
    contextKey: string;
};
export declare function resolveBaseExecApprovalDecision(params: {
    decision: string | null;
    askFallback: ResolvedExecApprovals["agent"]["askFallback"];
}): {
    approvedByAsk: boolean;
    deniedReason: string | null;
    timedOut: boolean;
};
export declare function resolveExecHostApprovalContext(params: {
    agentId?: string;
    security: ExecSecurity;
    ask: ExecAsk;
    host: "gateway" | "node";
}): ExecHostApprovalContext;
export declare function resolveApprovalDecisionOrUndefined(params: {
    approvalId: string;
    preResolvedDecision: string | null | undefined;
    onFailure: () => void;
}): Promise<string | null | undefined>;
export declare function resolveExecApprovalUnavailableState(params: {
    turnSourceChannel?: string;
    turnSourceAccountId?: string;
    preResolvedDecision: string | null | undefined;
}): {
    initiatingSurface: ExecApprovalInitiatingSurfaceState;
    sentApproverDms: boolean;
    unavailableReason: ExecApprovalUnavailableReason | null;
};
export declare function createAndRegisterDefaultExecApprovalRequest(params: {
    warnings: string[];
    approvalRunningNoticeMs: number;
    createApprovalSlug: (approvalId: string) => string;
    turnSourceChannel?: string;
    turnSourceAccountId?: string;
    register: (approvalId: string) => Promise<ExecApprovalRegistration>;
}): Promise<RegisteredExecApprovalRequestContext>;
export declare function buildDefaultExecApprovalRequestArgs(params: DefaultExecApprovalRequestArgs): DefaultExecApprovalRequestArgs;
export declare function buildExecApprovalFollowupTarget(params: ExecApprovalFollowupTarget): ExecApprovalFollowupTarget;
export declare function createExecApprovalDecisionState(params: {
    decision: string | null | undefined;
    askFallback: ResolvedExecApprovals["agent"]["askFallback"];
}): {
    baseDecision: {
        approvedByAsk: boolean;
        deniedReason: string | null;
        timedOut: boolean;
    };
    approvedByAsk: boolean;
    deniedReason: string | null;
};
export declare function enforceStrictInlineEvalApprovalBoundary(params: {
    baseDecision: {
        timedOut: boolean;
    };
    approvedByAsk: boolean;
    deniedReason: string | null;
    requiresInlineEvalApproval: boolean;
}): {
    approvedByAsk: boolean;
    deniedReason: string | null;
};
export declare function shouldResolveExecApprovalUnavailableInline(params: {
    trigger?: string;
    unavailableReason: ExecApprovalUnavailableReason | null;
    preResolvedDecision: string | null | undefined;
}): boolean;
export declare function buildHeadlessExecApprovalDeniedMessage(params: {
    trigger?: string;
    host: "gateway" | "node";
    security: ExecSecurity;
    ask: ExecAsk;
    askFallback: ResolvedExecApprovals["agent"]["askFallback"];
}): string;
export declare function sendExecApprovalFollowupResult(target: ExecApprovalFollowupTarget, resultText: string, deps?: ExecApprovalFollowupResultDeps): Promise<void>;
export declare function buildExecApprovalPendingToolResult(params: {
    host: "gateway" | "node";
    command: string;
    cwd: string | undefined;
    warningText: string;
    approvalId: string;
    approvalSlug: string;
    expiresAtMs: number;
    initiatingSurface: ExecApprovalInitiatingSurfaceState;
    sentApproverDms: boolean;
    unavailableReason: ExecApprovalUnavailableReason | null;
    allowedDecisions?: readonly ExecApprovalDecision[];
    nodeId?: string;
}): AgentToolResult<ExecToolDetails>;
export {};
