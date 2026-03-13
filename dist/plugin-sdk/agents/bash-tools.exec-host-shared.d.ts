import { resolveExecApprovals, type ExecAsk, type ExecSecurity } from "../infra/exec-approvals.js";
type ResolvedExecApprovals = ReturnType<typeof resolveExecApprovals>;
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
    obfuscationDetected: boolean;
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
export {};
