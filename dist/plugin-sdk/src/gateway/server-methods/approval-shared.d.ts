import type { ExecApprovalDecision } from "../../infra/exec-approvals.js";
import type { ExecApprovalManager, ExecApprovalRecord } from "../exec-approval-manager.js";
import { ErrorCodes } from "../protocol/index.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";
type PendingApprovalLookupError = "missing" | {
    code: (typeof ErrorCodes)["INVALID_REQUEST"];
    message: string;
};
type ApprovalTurnSourceFields = {
    turnSourceChannel?: string | null;
    turnSourceAccountId?: string | null;
};
type RequestedApprovalEvent<TPayload extends ApprovalTurnSourceFields> = {
    id: string;
    request: TPayload;
    createdAtMs: number;
    expiresAtMs: number;
};
export declare function isApprovalDecision(value: string): value is ExecApprovalDecision;
export declare function isApprovalRecordVisibleToClient<TPayload>(params: {
    record: ExecApprovalRecord<TPayload>;
    client: GatewayClient | null;
}): boolean;
export declare function resolveApprovalRequestRecipientConnIds<TPayload>(params: {
    context: GatewayRequestContext;
    record: ExecApprovalRecord<TPayload>;
    excludeConnId?: string;
}): ReadonlySet<string> | null;
export declare function resolvePendingApprovalRecord<TPayload>(params: {
    manager: ExecApprovalManager<TPayload>;
    inputId: string;
    client?: GatewayClient | null;
    exposeAmbiguousPrefixError?: boolean;
}): {
    ok: true;
    approvalId: string;
    snapshot: ExecApprovalRecord<TPayload>;
} | {
    ok: false;
    response: PendingApprovalLookupError;
};
export declare function respondPendingApprovalLookupError(params: {
    respond: RespondFn;
    response: PendingApprovalLookupError;
}): void;
export declare function handleApprovalWaitDecision<TPayload>(params: {
    manager: ExecApprovalManager<TPayload>;
    inputId: unknown;
    client?: GatewayClient | null;
    respond: RespondFn;
}): Promise<void>;
export declare function handlePendingApprovalRequest<TPayload extends ApprovalTurnSourceFields>(params: {
    manager: ExecApprovalManager<TPayload>;
    record: ExecApprovalRecord<TPayload>;
    decisionPromise: Promise<ExecApprovalDecision | null>;
    respond: RespondFn;
    context: GatewayRequestContext;
    clientConnId?: string;
    requestEventName: string;
    requestEvent: RequestedApprovalEvent<TPayload>;
    twoPhase: boolean;
    deliverRequest: () => boolean | Promise<boolean>;
    afterDecision?: (decision: ExecApprovalDecision | null, requestEvent: RequestedApprovalEvent<TPayload>) => Promise<void> | void;
    afterDecisionErrorLabel?: string;
}): Promise<void>;
export declare function handleApprovalResolve<TPayload, TResolvedEvent extends object>(params: {
    manager: ExecApprovalManager<TPayload>;
    inputId: string;
    decision: ExecApprovalDecision;
    respond: RespondFn;
    context: GatewayRequestContext;
    client: GatewayClient | null;
    exposeAmbiguousPrefixError?: boolean;
    validateDecision?: (snapshot: ExecApprovalRecord<TPayload>) => {
        message: string;
        details?: Record<string, unknown>;
    } | null | undefined;
    resolvedEventName: string;
    buildResolvedEvent: (params: {
        approvalId: string;
        decision: ExecApprovalDecision;
        resolvedBy: string | null;
        snapshot: ExecApprovalRecord<TPayload>;
        nowMs: number;
    }) => TResolvedEvent;
    forwardResolved?: (event: TResolvedEvent) => Promise<void> | void;
    forwardResolvedErrorLabel?: string;
    extraResolvedHandlers?: Array<{
        run: (event: TResolvedEvent) => Promise<void> | void;
        errorLabel: string;
    }>;
}): Promise<void>;
export {};
