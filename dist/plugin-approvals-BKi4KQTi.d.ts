import { o as ExecApprovalDecision } from "./exec-approvals-DZ3KhICc.js";

//#region src/infra/plugin-approvals.d.ts
type PluginApprovalRequestPayload = {
  pluginId?: string | null;
  title: string;
  description: string;
  severity?: "info" | "warning" | "critical" | null;
  toolName?: string | null;
  toolCallId?: string | null;
  allowedDecisions?: readonly ExecApprovalDecision[] | null;
  agentId?: string | null;
  sessionKey?: string | null;
  turnSourceChannel?: string | null;
  turnSourceTo?: string | null;
  turnSourceAccountId?: string | null;
  turnSourceThreadId?: string | number | null;
};
type PluginApprovalRequest = {
  id: string;
  request: PluginApprovalRequestPayload;
  createdAtMs: number;
  expiresAtMs: number;
};
type PluginApprovalResolved = {
  id: string;
  decision: ExecApprovalDecision;
  resolvedBy?: string | null;
  ts: number;
  request?: PluginApprovalRequestPayload;
};
declare const DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS = 120000;
declare const MAX_PLUGIN_APPROVAL_TIMEOUT_MS = 600000;
declare const PLUGIN_APPROVAL_TITLE_MAX_LENGTH = 80;
declare const PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH = 256;
declare const DEFAULT_PLUGIN_APPROVAL_DECISIONS: readonly ["allow-once", "allow-always", "deny"];
declare function approvalDecisionLabel(decision: ExecApprovalDecision): string;
declare function resolvePluginApprovalRequestAllowedDecisions(params?: {
  allowedDecisions?: readonly ExecApprovalDecision[] | readonly string[] | null;
}): readonly ExecApprovalDecision[];
declare function buildPluginApprovalRequestMessage(request: PluginApprovalRequest, nowMsValue: number): string;
declare function buildPluginApprovalResolvedMessage(resolved: PluginApprovalResolved): string;
declare function buildPluginApprovalExpiredMessage(request: PluginApprovalRequest): string;
//#endregion
export { PLUGIN_APPROVAL_TITLE_MAX_LENGTH as a, PluginApprovalResolved as c, buildPluginApprovalRequestMessage as d, buildPluginApprovalResolvedMessage as f, PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH as i, approvalDecisionLabel as l, DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS as n, PluginApprovalRequest as o, resolvePluginApprovalRequestAllowedDecisions as p, MAX_PLUGIN_APPROVAL_TIMEOUT_MS as r, PluginApprovalRequestPayload as s, DEFAULT_PLUGIN_APPROVAL_DECISIONS as t, buildPluginApprovalExpiredMessage as u };