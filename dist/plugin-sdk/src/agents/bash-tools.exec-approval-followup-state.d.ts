import type { ExecElevatedDefaults } from "./bash-tools.exec-types.js";
export type ExecApprovalFollowupRuntimeHandoff = {
    kind: "exec-approval-followup";
    approvalId: string;
    sessionKey: string;
    idempotencyKey: string;
    bashElevated: ExecElevatedDefaults;
};
export type ExecApprovalFollowupRuntimeHandoffRegistration = {
    handoffId: string;
    idempotencyKey: string;
};
export declare function buildExecApprovalFollowupIdempotencyKey(params: {
    approvalId: string;
    nonce?: string;
}): string;
export declare function parseExecApprovalFollowupApprovalId(idempotencyKey: string): string | undefined;
export declare function registerExecApprovalFollowupRuntimeHandoff(params: {
    approvalId: string;
    sessionKey: string;
    bashElevated?: ExecElevatedDefaults;
    nowMs?: number;
}): ExecApprovalFollowupRuntimeHandoffRegistration | undefined;
export declare function consumeExecApprovalFollowupRuntimeHandoff(params: {
    handoffId?: string;
    approvalId?: string;
    idempotencyKey?: string;
    sessionKey?: string;
    nowMs?: number;
}): ExecApprovalFollowupRuntimeHandoff | undefined;
export declare function resetExecApprovalFollowupRuntimeHandoffsForTests(): void;
