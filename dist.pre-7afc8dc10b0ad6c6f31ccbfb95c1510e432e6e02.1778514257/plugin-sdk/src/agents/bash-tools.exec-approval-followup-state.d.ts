import type { ExecElevatedDefaults } from "./bash-tools.exec-types.js";
export declare function buildExecApprovalFollowupIdempotencyKey(params: {
    approvalId: string;
    execApprovalFollowupToken?: string;
}): string;
export declare function registerExecApprovalFollowupElevatedDefaults(params: {
    sessionKey: string;
    bashElevated?: ExecElevatedDefaults;
    nowMs?: number;
}): string | undefined;
export declare function consumeExecApprovalFollowupElevatedDefaults(params: {
    token?: string;
    sessionKey?: string;
    nowMs?: number;
}): ExecElevatedDefaults | undefined;
export declare function consumeExecApprovalFollowupElevatedDefaultsFromIdempotencyKey(params: {
    idempotencyKey: string;
    sessionKey?: string;
    nowMs?: number;
}): ExecElevatedDefaults | undefined;
export declare function resetExecApprovalFollowupElevatedDefaultsForTests(): void;
