import type { ExecApprovalDecision, ExecApprovalRequestPayload as InfraExecApprovalRequestPayload } from "../infra/exec-approvals.js";
export type ExecApprovalRequestPayload = InfraExecApprovalRequestPayload;
export type ExecApprovalRecord = {
    id: string;
    request: ExecApprovalRequestPayload;
    createdAtMs: number;
    expiresAtMs: number;
    requestedByConnId?: string | null;
    requestedByDeviceId?: string | null;
    requestedByClientId?: string | null;
    resolvedAtMs?: number;
    decision?: ExecApprovalDecision;
    resolvedBy?: string | null;
};
export declare class ExecApprovalManager {
    private pending;
    create(request: ExecApprovalRequestPayload, timeoutMs: number, id?: string | null): ExecApprovalRecord;
    /**
     * Register an approval record and return a promise that resolves when the decision is made.
     * This separates registration (synchronous) from waiting (async), allowing callers to
     * confirm registration before the decision is made.
     */
    register(record: ExecApprovalRecord, timeoutMs: number): Promise<ExecApprovalDecision | null>;
    /**
     * @deprecated Use register() instead for explicit separation of registration and waiting.
     */
    waitForDecision(record: ExecApprovalRecord, timeoutMs: number): Promise<ExecApprovalDecision | null>;
    resolve(recordId: string, decision: ExecApprovalDecision, resolvedBy?: string | null): boolean;
    expire(recordId: string, resolvedBy?: string | null): boolean;
    getSnapshot(recordId: string): ExecApprovalRecord | null;
    consumeAllowOnce(recordId: string): boolean;
    /**
     * Wait for decision on an already-registered approval.
     * Returns the decision promise if the ID is pending, null otherwise.
     */
    awaitDecision(recordId: string): Promise<ExecApprovalDecision | null> | null;
}
