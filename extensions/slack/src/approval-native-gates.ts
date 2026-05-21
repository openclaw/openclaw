import {
  isChannelExecApprovalClientEnabledFromConfig,
  matchesApprovalRequestFilters,
} from "openclaw/plugin-sdk/approval-client-runtime";
import { doesApprovalRequestMatchChannelAccount } from "openclaw/plugin-sdk/approval-native-runtime";
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveSlackAccount } from "./accounts.js";
import { getSlackApprovalApprovers } from "./approval-auth.js";
import {
  getSlackExecApprovalApprovers,
  isSlackExecApprovalClientEnabled,
} from "./exec-approvals.js";

export type SlackApprovalKind = "exec" | "plugin";
export type SlackNativeApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;

export function resolveSlackApprovalKind(request: SlackNativeApprovalRequest): SlackApprovalKind {
  return request.id.startsWith("plugin:") ? "plugin" : "exec";
}

function resolveSlackNativeApprovalConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}) {
  return resolveSlackAccount(params).config.execApprovals;
}

function getSlackNativeApprovalApprovers(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind: SlackApprovalKind;
}): string[] {
  return params.approvalKind === "plugin"
    ? getSlackApprovalApprovers(params)
    : getSlackExecApprovalApprovers(params);
}

export function isSlackNativeApprovalClientEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind: SlackApprovalKind;
}): boolean {
  if (params.approvalKind === "exec") {
    return isSlackExecApprovalClientEnabled(params);
  }
  const config = resolveSlackNativeApprovalConfig(params);
  return isChannelExecApprovalClientEnabledFromConfig({
    enabled: config?.enabled,
    approverCount: getSlackNativeApprovalApprovers(params).length,
  });
}

export function isSlackAnyNativeApprovalClientEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  return (
    isSlackNativeApprovalClientEnabled({
      ...params,
      approvalKind: "exec",
    }) ||
    isSlackNativeApprovalClientEnabled({
      ...params,
      approvalKind: "plugin",
    })
  );
}

export function shouldHandleSlackNativeApprovalRequest(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind?: SlackApprovalKind;
  request: SlackNativeApprovalRequest;
}): boolean {
  const approvalKind = params.approvalKind ?? resolveSlackApprovalKind(params.request);
  if (
    !doesApprovalRequestMatchChannelAccount({
      cfg: params.cfg,
      request: params.request,
      channel: "slack",
      accountId: params.accountId,
    })
  ) {
    return false;
  }
  const config = resolveSlackNativeApprovalConfig(params);
  if (
    !isChannelExecApprovalClientEnabledFromConfig({
      enabled: config?.enabled,
      approverCount: getSlackNativeApprovalApprovers({
        ...params,
        approvalKind,
      }).length,
    })
  ) {
    return false;
  }
  return matchesApprovalRequestFilters({
    request: params.request.request,
    agentFilter: config?.agentFilter,
    sessionFilter: config?.sessionFilter,
  });
}

export function shouldDeliverSlackNativeApprovalRequest(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind: SlackApprovalKind;
  request: SlackNativeApprovalRequest;
}): boolean {
  return shouldHandleSlackNativeApprovalRequest({
    cfg: params.cfg,
    accountId: params.accountId,
    approvalKind: params.approvalKind,
    request: params.request,
  });
}
