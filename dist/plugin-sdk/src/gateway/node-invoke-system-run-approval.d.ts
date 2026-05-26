import type { ExecApprovalRecord } from "./exec-approval-manager.js";
type ApprovalLookup = {
    getSnapshot: (recordId: string) => ExecApprovalRecord | null;
    consumeAllowOnce?: (recordId: string) => boolean;
};
type ApprovalClient = {
    connId?: string | null;
    isDeviceTokenAuth?: boolean;
    connect?: {
        scopes?: unknown;
        client?: {
            id?: string | null;
            mode?: string | null;
        } | null;
        device?: {
            id?: string | null;
        } | null;
    } | null;
};
/**
 * Gate `system.run` approval flags (`approved`, `approvalDecision`) behind a real
 * `exec.approval.*` record. This prevents users with only `operator.write` from
 * bypassing node-host approvals by injecting control fields into `node.invoke`.
 */
export declare function sanitizeSystemRunParamsForForwarding(opts: {
    nodeId?: string | null;
    rawParams: unknown;
    client: ApprovalClient | null;
    execApprovalManager?: ApprovalLookup;
    nowMs?: number;
}): {
    ok: true;
    params: unknown;
} | {
    ok: false;
    message: string;
    details?: Record<string, unknown>;
};
export {};
