import type { ExecAsk, ExecSecurity, SystemRunApprovalPlan } from "../infra/exec-approvals.js";
export type RequestExecApprovalDecisionParams = {
    id: string;
    command?: string;
    commandArgv?: string[];
    systemRunPlan?: SystemRunApprovalPlan;
    env?: Record<string, string>;
    cwd: string | undefined;
    nodeId?: string;
    host: "gateway" | "node";
    security: ExecSecurity;
    ask: ExecAsk;
    agentId?: string;
    resolvedPath?: string;
    sessionKey?: string;
    turnSourceChannel?: string;
    turnSourceTo?: string;
    turnSourceAccountId?: string;
    turnSourceThreadId?: string | number;
};
export type ExecApprovalRegistration = {
    id: string;
    expiresAtMs: number;
    finalDecision?: string | null;
};
export declare function registerExecApprovalRequest(params: RequestExecApprovalDecisionParams): Promise<ExecApprovalRegistration>;
export declare function waitForExecApprovalDecision(id: string): Promise<string | null>;
export declare function resolveRegisteredExecApprovalDecision(params: {
    approvalId: string;
    preResolvedDecision: string | null | undefined;
}): Promise<string | null>;
export declare function requestExecApprovalDecision(params: RequestExecApprovalDecisionParams): Promise<string | null>;
type HostExecApprovalParams = {
    approvalId: string;
    command?: string;
    commandArgv?: string[];
    systemRunPlan?: SystemRunApprovalPlan;
    env?: Record<string, string>;
    workdir: string | undefined;
    host: "gateway" | "node";
    nodeId?: string;
    security: ExecSecurity;
    ask: ExecAsk;
    agentId?: string;
    resolvedPath?: string;
    sessionKey?: string;
    turnSourceChannel?: string;
    turnSourceTo?: string;
    turnSourceAccountId?: string;
    turnSourceThreadId?: string | number;
};
type ExecApprovalRequesterContext = {
    agentId?: string;
    sessionKey?: string;
};
export declare function buildExecApprovalRequesterContext(params: ExecApprovalRequesterContext): {
    agentId?: string;
    sessionKey?: string;
};
type ExecApprovalTurnSourceContext = {
    turnSourceChannel?: string;
    turnSourceTo?: string;
    turnSourceAccountId?: string;
    turnSourceThreadId?: string | number;
};
export declare function buildExecApprovalTurnSourceContext(params: ExecApprovalTurnSourceContext): ExecApprovalTurnSourceContext;
export declare function requestExecApprovalDecisionForHost(params: HostExecApprovalParams): Promise<string | null>;
export declare function registerExecApprovalRequestForHost(params: HostExecApprovalParams): Promise<ExecApprovalRegistration>;
export declare function registerExecApprovalRequestForHostOrThrow(params: HostExecApprovalParams): Promise<ExecApprovalRegistration>;
export {};
