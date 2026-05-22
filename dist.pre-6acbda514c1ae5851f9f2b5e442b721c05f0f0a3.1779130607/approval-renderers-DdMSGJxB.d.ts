import { r as ReplyPayload } from "./reply-payload-DpKGqclz.js";
import { c as PluginApprovalResolved, o as PluginApprovalRequest } from "./plugin-approvals-OZwFprko.js";
import { r as ExecApprovalReplyDecision } from "./exec-approval-reply-Hul5O6j1.js";

//#region src/plugin-sdk/approval-renderers.d.ts
/** Build a pending approval reply payload using the portable presentation API. */
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
/** Build a resolved approval reply payload with approval metadata but no controls. */
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