import { S as MessagePresentationButton, b as MessagePresentation, m as InteractiveReply, s as ReplyPayload } from "./get-reply-options.types-DiZecFJG.js";
import { _ as ExecHost, o as ExecApprovalDecision } from "./exec-approvals-DZ3KhICc.js";
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
  style: NonNullable<MessagePresentationButton["style"]>;
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
/** Build the portable approval button presentation for already-resolved actions. */
declare function buildApprovalPresentationFromActionDescriptors(actions: readonly ExecApprovalActionDescriptor[]): MessagePresentation | undefined;
/** Build the portable approval presentation for an approval id and decision allowlist. */
declare function buildApprovalPresentation(params: {
  approvalId: string;
  ask?: string | null;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
}): MessagePresentation | undefined;
/** Build the portable exec-approval presentation for command callback buttons. */
declare function buildExecApprovalPresentation(params: {
  approvalCommandId: string;
  ask?: string | null;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
}): MessagePresentation | undefined;
/**
 * @deprecated Use buildApprovalPresentationFromActionDescriptors.
 */
declare function buildApprovalInteractiveReplyFromActionDescriptors(actions: readonly ExecApprovalActionDescriptor[]): InteractiveReply | undefined;
/**
 * @deprecated Use buildApprovalPresentation.
 */
declare function buildApprovalInteractiveReply(params: {
  approvalId: string;
  ask?: string | null;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
}): InteractiveReply | undefined;
/**
 * @deprecated Use buildExecApprovalPresentation.
 */
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
export { formatExecApprovalExpiresIn as _, ExecApprovalUnavailableReason as a, parseExecApprovalCommandText as b, buildApprovalInteractiveReplyFromActionDescriptors as c, buildExecApprovalActionDescriptors as d, buildExecApprovalCommandText as f, buildExecApprovalUnavailableReplyPayload as g, buildExecApprovalPresentation as h, ExecApprovalReplyMetadata as i, buildApprovalPresentation as l, buildExecApprovalPendingReplyPayload as m, ExecApprovalPendingReplyParams as n, ExecApprovalUnavailableReplyParams as o, buildExecApprovalInteractiveReply as p, ExecApprovalReplyDecision as r, buildApprovalInteractiveReply as s, ExecApprovalActionDescriptor as t, buildApprovalPresentationFromActionDescriptors as u, getExecApprovalApproverDmNoticeText as v, getExecApprovalReplyMetadata as y };