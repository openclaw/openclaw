import type { ReplyPayload } from "../auto-reply/types.js";
import type { ExecHost } from "./exec-approvals.js";
export type ExecApprovalReplyDecision = "allow-once" | "allow-always" | "deny";
export type ExecApprovalUnavailableReason = "initiating-platform-disabled" | "initiating-platform-unsupported" | "no-approval-route";
export type ExecApprovalReplyMetadata = {
    approvalId: string;
    approvalSlug: string;
    allowedDecisions?: readonly ExecApprovalReplyDecision[];
};
export type ExecApprovalPendingReplyParams = {
    warningText?: string;
    approvalId: string;
    approvalSlug: string;
    approvalCommandId?: string;
    command: string;
    cwd?: string;
    host: ExecHost;
    nodeId?: string;
    expiresAtMs?: number;
    nowMs?: number;
};
export type ExecApprovalUnavailableReplyParams = {
    warningText?: string;
    channelLabel?: string;
    reason: ExecApprovalUnavailableReason;
    sentApproverDms?: boolean;
};
export declare function getExecApprovalApproverDmNoticeText(): string;
export declare function getExecApprovalReplyMetadata(payload: ReplyPayload): ExecApprovalReplyMetadata | null;
export declare function buildExecApprovalPendingReplyPayload(params: ExecApprovalPendingReplyParams): ReplyPayload;
export declare function buildExecApprovalUnavailableReplyPayload(params: ExecApprovalUnavailableReplyParams): ReplyPayload;
