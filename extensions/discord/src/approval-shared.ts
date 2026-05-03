import { doesApprovalRequestMatchChannelAccount } from "openclaw/plugin-sdk/approval-native-runtime";
import type { DiscordExecApprovalConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ExecApprovalRequest, PluginApprovalRequest } from "openclaw/plugin-sdk/infra-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { listDiscordAccountIds, resolveDiscordAccount } from "./accounts.js";
import {
  isChannelExecApprovalClientEnabledFromConfig,
  matchesApprovalRequestFilters,
} from "./approval-runtime.js";
import { getDiscordExecApprovalApprovers } from "./exec-approvals.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;

type DiscordApprovalConfigInput = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: ApprovalRequest;
  configOverride?: DiscordExecApprovalConfig | null;
};

function getDiscordApprovalConfig(params: DiscordApprovalConfigInput) {
  return (
    params.configOverride ??
    resolveDiscordAccount({ cfg: params.cfg, accountId: params.accountId }).config.execApprovals
  );
}

function isDiscordApprovalRequestEligible(params: DiscordApprovalConfigInput): boolean {
  const config = getDiscordApprovalConfig(params);
  const approvers = getDiscordExecApprovalApprovers({
    cfg: params.cfg,
    accountId: params.accountId,
    configOverride: params.configOverride,
  });
  if (
    !isChannelExecApprovalClientEnabledFromConfig({
      enabled: config?.enabled,
      approverCount: approvers.length,
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

function countDiscordApprovalEligibleAccounts(params: {
  cfg: OpenClawConfig;
  request: ApprovalRequest;
  configOverride?: DiscordExecApprovalConfig | null;
}): number {
  return listDiscordAccountIds(params.cfg).filter((accountId) =>
    isDiscordApprovalRequestEligible({
      cfg: params.cfg,
      accountId,
      request: params.request,
      configOverride: params.configOverride,
    }),
  ).length;
}

function doesDiscordApprovalRequestMatchChannelAccount(
  params: DiscordApprovalConfigInput,
): boolean {
  if (
    doesApprovalRequestMatchChannelAccount({
      cfg: params.cfg,
      request: params.request,
      channel: "discord",
      accountId: params.accountId,
    })
  ) {
    return true;
  }

  const turnSourceChannel = normalizeLowercaseStringOrEmpty(
    params.request.request.turnSourceChannel,
  );
  if (!turnSourceChannel || turnSourceChannel === "discord") {
    return false;
  }

  return (
    countDiscordApprovalEligibleAccounts({
      cfg: params.cfg,
      request: params.request,
      configOverride: params.configOverride,
    }) <= 1
  );
}

export function shouldHandleDiscordApprovalRequest(params: DiscordApprovalConfigInput): boolean {
  if (!doesDiscordApprovalRequestMatchChannelAccount(params)) {
    return false;
  }
  return isDiscordApprovalRequestEligible(params);
}
