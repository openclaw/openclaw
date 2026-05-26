import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { s as ExecApprovalRequest } from "./exec-approvals-DZ3KhICc.js";
import { o as PluginApprovalRequest } from "./plugin-approvals-BKi4KQTi.js";
import { n as ExecApprovalSessionTarget } from "./exec-approval-session-target-BDj8rOxc.js";

//#region src/plugin-sdk/approval-native-helpers.d.ts
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
type NativeApprovalTarget = {
  to: string;
  accountId?: string | null;
  threadId?: string | number | null;
};
declare function createChannelNativeOriginTargetResolver<TTarget extends NativeApprovalTarget>(params: NativeOriginResolverParams<TTarget>): (input: ApprovalResolverParams) => TTarget | null;
declare function createChannelNativeOriginTargetResolver<TTarget>(params: CustomOriginResolverParams<TTarget>): (input: ApprovalResolverParams) => TTarget | null;
declare function createChannelApproverDmTargetResolver<TApprover, TTarget extends NativeApprovalTarget = NativeApprovalTarget>(params: {
  shouldHandleRequest?: (params: ApprovalResolverParams) => boolean;
  resolveApprovers: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => readonly TApprover[];
  mapApprover: (approver: TApprover, params: ApprovalResolverParams) => TTarget | null | undefined;
}): (input: ApprovalResolverParams) => TTarget[];
//#endregion
//#region src/infra/approval-request-account-binding.d.ts
type ApprovalRequestLike = ExecApprovalRequest | PluginApprovalRequest;
declare function resolveApprovalRequestAccountId(params: {
  cfg: OpenClawConfig;
  request: ApprovalRequestLike;
  channel?: string | null;
}): string | null;
declare function resolveApprovalRequestChannelAccountId(params: {
  cfg: OpenClawConfig;
  request: ApprovalRequestLike;
  channel: string;
}): string | null;
declare function doesApprovalRequestMatchChannelAccount(params: {
  cfg: OpenClawConfig;
  request: ApprovalRequestLike;
  channel: string;
  accountId?: string | null;
}): boolean;
//#endregion
export { createChannelNativeOriginTargetResolver as a, createChannelApproverDmTargetResolver as i, resolveApprovalRequestAccountId as n, resolveApprovalRequestChannelAccountId as r, doesApprovalRequestMatchChannelAccount as t };