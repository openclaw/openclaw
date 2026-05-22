type ExecApprovalFollowupParams = {
    approvalId: string;
    sessionKey?: string;
    turnSourceChannel?: string;
    turnSourceTo?: string;
    turnSourceAccountId?: string;
    turnSourceThreadId?: string | number;
    resultText: string;
    direct?: boolean;
    internalRuntimeHandoffId?: string;
    idempotencyKey?: string;
};
export declare function buildExecApprovalFollowupPrompt(resultText: string): string;
export declare function sendExecApprovalFollowup(params: ExecApprovalFollowupParams): Promise<boolean>;
export {};
