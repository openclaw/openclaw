import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { s as ExecApprovalRequest } from "./exec-approvals-DZ3KhICc.js";
import { o as PluginApprovalRequest } from "./plugin-approvals-BKi4KQTi.js";

//#region src/infra/exec-approval-session-target.d.ts
type ExecApprovalSessionTarget = {
  channel?: string;
  to: string;
  accountId?: string;
  threadId?: string | number;
};
type ApprovalRequestSessionConversation = {
  channel: string;
  kind: "group" | "channel";
  id: string;
  rawId: string;
  threadId?: string;
  baseSessionKey: string;
  baseConversationId: string;
  parentConversationCandidates: string[];
};
type ApprovalRequestLike = ExecApprovalRequest | PluginApprovalRequest;
type ApprovalRequestOriginTargetResolver<TTarget> = {
  cfg: OpenClawConfig;
  request: ApprovalRequestLike;
  channel: string;
  accountId?: string | null;
  resolveTurnSourceTarget: (request: ApprovalRequestLike) => TTarget | null;
  resolveSessionTarget: (sessionTarget: ExecApprovalSessionTarget) => TTarget | null;
  targetsMatch: (a: TTarget, b: TTarget) => boolean;
  resolveFallbackTarget?: (request: ApprovalRequestLike) => TTarget | null;
};
declare function resolveApprovalRequestSessionConversation(params: {
  request: ApprovalRequestLike;
  channel?: string | null;
  bundledFallback?: boolean;
}): ApprovalRequestSessionConversation | null;
declare function resolveExecApprovalSessionTarget(params: {
  cfg: OpenClawConfig;
  request: ExecApprovalRequest;
  turnSourceChannel?: string | null;
  turnSourceTo?: string | null;
  turnSourceAccountId?: string | null;
  turnSourceThreadId?: string | number | null;
}): ExecApprovalSessionTarget | null;
declare function resolveApprovalRequestSessionTarget(params: {
  cfg: OpenClawConfig;
  request: ApprovalRequestLike;
}): ExecApprovalSessionTarget | null;
declare function resolveApprovalRequestOriginTarget<TTarget>(params: ApprovalRequestOriginTargetResolver<TTarget>): TTarget | null;
//#endregion
export { resolveApprovalRequestSessionTarget as a, resolveApprovalRequestSessionConversation as i, ExecApprovalSessionTarget as n, resolveExecApprovalSessionTarget as o, resolveApprovalRequestOriginTarget as r, ApprovalRequestSessionConversation as t };