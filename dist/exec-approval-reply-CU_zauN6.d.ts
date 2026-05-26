import { s as ReplyPayload } from "./get-reply-options.types-BalBo_kk.js";
import { i as InteractiveReplyButton, n as InteractiveReply } from "./payload-BuuA629O.js";
import { _ as ExecHost, o as ExecApprovalDecision } from "./exec-approvals-BpVWMnuu.js";
//#region src/infra/exec-approval-reply.d.ts
type ExecApprovalReplyDecision = ExecApprovalDecision;
type ExecApprovalUnavailableReason = "initiating-platform-disabled" | "initiating-platform-unsupported" | "no-approval-route";
type ExecApprovalReplyMetadata = {
  approvalId: string;
  approvalSlug: string;
  approvalKind: "exec" | "plugin";
  agentId?: string;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
  sessionKey?: string;
};
type ExecApprovalActionDescriptor = {
  decision: ExecApprovalReplyDecision;
  label: string;
  style: NonNullable<InteractiveReplyButton["style"]>;
  command: string;
};
type ExecApprovalPendingReplyParams = {
  warningText?: string;
  approvalId: string;
  approvalSlug: string;
  approvalCommandId?: string;
  ask?: string | null;
  agentId?: string | null;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
  command: string;
  cwd?: string;
  host: ExecHost;
  nodeId?: string;
  sessionKey?: string | null;
  expiresAtMs?: number;
  nowMs?: number;
};
type ExecApprovalUnavailableReplyParams = {
  warningText?: string;
  channel?: string;
  channelLabel?: string;
  accountId?: string;
  reason: ExecApprovalUnavailableReason;
  sentApproverDms?: boolean;
};
declare function buildExecApprovalCommandText(params: {
  approvalCommandId: string;
  decision: ExecApprovalReplyDecision;
}): string;
declare function buildExecApprovalActionDescriptors(params: {
  approvalCommandId: string;
  ask?: string | null;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
}): ExecApprovalActionDescriptor[];
declare function buildApprovalInteractiveReplyFromActionDescriptors(actions: readonly ExecApprovalActionDescriptor[]): InteractiveReply | undefined;
declare function buildApprovalInteractiveReply(params: {
  approvalId: string;
  ask?: string | null;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
}): InteractiveReply | undefined;
declare function buildExecApprovalInteractiveReply(params: {
  approvalCommandId: string;
  ask?: string | null;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
}): InteractiveReply | undefined;
declare function getExecApprovalApproverDmNoticeText(): string;
declare function parseExecApprovalCommandText(raw: string): {
  approvalId: string;
  decision: ExecApprovalReplyDecision;
} | null;
declare function formatExecApprovalExpiresIn(expiresAtMs: number, nowMs: number): string;
declare function getExecApprovalReplyMetadata(payload: ReplyPayload): ExecApprovalReplyMetadata | null;
declare function buildExecApprovalPendingReplyPayload(params: ExecApprovalPendingReplyParams): ReplyPayload;
declare function buildExecApprovalUnavailableReplyPayload(params: ExecApprovalUnavailableReplyParams): ReplyPayload;
//#endregion
export { parseExecApprovalCommandText as _, ExecApprovalUnavailableReason as a, buildApprovalInteractiveReplyFromActionDescriptors as c, buildExecApprovalInteractiveReply as d, buildExecApprovalPendingReplyPayload as f, getExecApprovalReplyMetadata as g, getExecApprovalApproverDmNoticeText as h, ExecApprovalReplyMetadata as i, buildExecApprovalActionDescriptors as l, formatExecApprovalExpiresIn as m, ExecApprovalPendingReplyParams as n, ExecApprovalUnavailableReplyParams as o, buildExecApprovalUnavailableReplyPayload as p, ExecApprovalReplyDecision as r, buildApprovalInteractiveReply as s, ExecApprovalActionDescriptor as t, buildExecApprovalCommandText as u };