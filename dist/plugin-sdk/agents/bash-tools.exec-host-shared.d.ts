import { resolveExecApprovals, type ExecAsk, type ExecSecurity } from "../infra/exec-approvals.js";
type ResolvedExecApprovals = ReturnType<typeof resolveExecApprovals>;
export type ExecHostApprovalContext = {
    approvals: ResolvedExecApprovals;
    hostSecurity: ExecSecurity;
    hostAsk: ExecAsk;
    askFallback: ResolvedExecApprovals["agent"]["askFallback"];
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
