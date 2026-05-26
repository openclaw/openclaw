import type { ExecApprovalSessionTarget } from "../infra/exec-approval-session-target.js";
import type { ExecApprovalRequest } from "../infra/exec-approvals.js";
import type { PluginApprovalRequest } from "../infra/plugin-approvals.js";
import type { OpenClawConfig } from "./config-runtime.js";
type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type ApprovalKind = "exec" | "plugin";
type ApprovalResolverParams = {
    cfg: OpenClawConfig;
    accountId?: string | null;
    approvalKind?: ApprovalKind;
    request: ApprovalRequest;
};
type NativeApprovalTargetNormalizer<TTarget> = (target: TTarget, request: ApprovalRequest) => TTarget | null | undefined;
type NativeOriginResolverParams<TTarget extends NativeApprovalTarget> = {
    channel: string;
    shouldHandleRequest?: (params: ApprovalResolverParams) => boolean;
    resolveTurnSourceTarget: (request: ApprovalRequest) => TTarget | null;
    resolveSessionTarget: (sessionTarget: ExecApprovalSessionTarget, request: ApprovalRequest) => TTarget | null;
    normalizeTarget?: NativeApprovalTargetNormalizer<TTarget>;
    normalizeTargetForMatch?: NativeApprovalTargetNormalizer<TTarget>;
    targetsMatch?: (a: TTarget, b: TTarget) => boolean;
    resolveFallbackTarget?: (request: ApprovalRequest) => TTarget | null;
};
type CustomOriginResolverParams<TTarget> = {
    channel: string;
    shouldHandleRequest?: (params: ApprovalResolverParams) => boolean;
    resolveTurnSourceTarget: (request: ApprovalRequest) => TTarget | null;
    resolveSessionTarget: (sessionTarget: ExecApprovalSessionTarget, request: ApprovalRequest) => TTarget | null;
    normalizeTarget?: NativeApprovalTargetNormalizer<TTarget>;
    normalizeTargetForMatch?: NativeApprovalTargetNormalizer<TTarget>;
    targetsMatch: (a: TTarget, b: TTarget) => boolean;
    resolveFallbackTarget?: (request: ApprovalRequest) => TTarget | null;
};
export type NativeApprovalTarget = {
    to: string;
    accountId?: string | null;
    threadId?: string | number | null;
};
export declare function nativeApprovalTargetsMatch(params: {
    channel?: string | null;
    left: NativeApprovalTarget;
    right: NativeApprovalTarget;
}): boolean;
export declare function createChannelNativeOriginTargetResolver<TTarget extends NativeApprovalTarget>(params: NativeOriginResolverParams<TTarget>): (input: ApprovalResolverParams) => TTarget | null;
export declare function createChannelNativeOriginTargetResolver<TTarget>(params: CustomOriginResolverParams<TTarget>): (input: ApprovalResolverParams) => TTarget | null;
export declare function createChannelApproverDmTargetResolver<TApprover, TTarget extends NativeApprovalTarget = NativeApprovalTarget>(params: {
    shouldHandleRequest?: (params: ApprovalResolverParams) => boolean;
    resolveApprovers: (params: {
        cfg: OpenClawConfig;
        accountId?: string | null;
    }) => readonly TApprover[];
    mapApprover: (approver: TApprover, params: ApprovalResolverParams) => TTarget | null | undefined;
}): (input: ApprovalResolverParams) => TTarget[];
export {};
