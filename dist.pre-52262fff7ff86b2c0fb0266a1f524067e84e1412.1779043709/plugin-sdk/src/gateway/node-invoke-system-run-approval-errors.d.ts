type SystemRunApprovalGuardError = {
    ok: false;
    message: string;
    details: Record<string, unknown>;
};
export declare function systemRunApprovalGuardError(params: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
}): SystemRunApprovalGuardError;
export declare function systemRunApprovalRequired(runId: string): SystemRunApprovalGuardError;
export {};
