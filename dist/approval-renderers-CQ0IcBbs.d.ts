import { r as ReplyPayload } from "./reply-payload-DjPL5qa-.js";
import { c as PluginApprovalResolved, o as PluginApprovalRequest } from "./plugin-approvals-BiH4NDIm.js";
import { r as ExecApprovalReplyDecision } from "./exec-approval-reply-CU_zauN6.js";

//#region src/plugin-sdk/approval-renderers.d.ts
declare function buildApprovalPendingReplyPayload(params: {
  approvalKind?: "exec" | "plugin";
  approvalId: string;
  approvalSlug: string;
  text: string;
  agentId?: string | null;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
  sessionKey?: string | null;
  channelData?: Record<string, unknown>;
}): ReplyPayload;
declare function buildApprovalResolvedReplyPayload(params: {
  approvalId: string;
  approvalSlug: string;
  text: string;
  channelData?: Record<string, unknown>;
}): ReplyPayload;
declare function buildPluginApprovalPendingReplyPayload(params: {
  request: PluginApprovalRequest;
  nowMs: number;
  text?: string;
  approvalSlug?: string;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
  channelData?: Record<string, unknown>;
}): ReplyPayload;
declare function buildPluginApprovalResolvedReplyPayload(params: {
  resolved: PluginApprovalResolved;
  text?: string;
  approvalSlug?: string;
  channelData?: Record<string, unknown>;
}): ReplyPayload;
//#endregion
export { buildPluginApprovalResolvedReplyPayload as i, buildApprovalResolvedReplyPayload as n, buildPluginApprovalPendingReplyPayload as r, buildApprovalPendingReplyPayload as t };