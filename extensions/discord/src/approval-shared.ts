import { doesApprovalRequestSelectChannelAccount } from "openclaw/plugin-sdk/approval-native-runtime";
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
  SystemAgentApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type {
  DiscordExecApprovalConfig,
  OpenClawConfig,
} from "openclaw/plugin-sdk/config-contracts";
import { resolveDefaultDiscordAccountId, resolveDiscordAccount } from "./accounts.js";
import { matchesApprovalRequestFilters } from "./approval-runtime.js";
import {
  canUseLinkedDiscordApprover,
  getDiscordExecApprovalApprovers,
  isDiscordExecApprovalClientEnabled,
  prepareDiscordApprovalAuthority,
} from "./exec-approvals.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest | SystemAgentApprovalRequest;

function getDiscordApprovalRequester(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: ApprovalRequest;
  configOverride?: DiscordExecApprovalConfig | null;
}): string | undefined {
  const identity = params.request.requesterChannelIdentity;
  return canUseLinkedDiscordApprover(params) &&
    identity?.channelId === "discord" &&
    identity.accountId === resolveDiscordAccount(params).accountId
    ? identity.senderId
    : undefined;
}

export async function resolveDiscordApprovalRequestApprovers(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: ApprovalRequest;
  configOverride?: DiscordExecApprovalConfig | null;
}): Promise<string[]> {
  if (!shouldHandleDiscordApprovalRequest(params)) {
    return [];
  }
  const approvers = getDiscordExecApprovalApprovers(params);
  const senderId = getDiscordApprovalRequester(params);
  if (senderId && !approvers.includes(senderId)) {
    const authority = await prepareDiscordApprovalAuthority({ ...params, senderId });
    if (authority) {
      authority.assertCurrent();
      approvers.push(senderId);
    }
  }
  return approvers;
}

function isDiscordApprovalAccountEligible(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: ApprovalRequest;
  configOverride?: DiscordExecApprovalConfig | null;
}): boolean {
  const account = resolveDiscordAccount(params);
  const config = params.configOverride ?? account.config.execApprovals;
  return (
    account.enabled &&
    isDiscordExecApprovalClientEnabled(params) &&
    (getDiscordExecApprovalApprovers(params).length > 0 ||
      Boolean(getDiscordApprovalRequester(params))) &&
    matchesApprovalRequestFilters({
      request: params.request.request,
      agentFilter: config?.agentFilter,
      sessionFilter: config?.sessionFilter,
    })
  );
}

export function shouldHandleDiscordApprovalRequest(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: ApprovalRequest;
  configOverride?: DiscordExecApprovalConfig | null;
}): boolean {
  const accountId = params.accountId ?? resolveDefaultDiscordAccountId(params.cfg);
  if (
    !doesApprovalRequestSelectChannelAccount({
      ...params,
      channel: "discord",
      defaultAccountId: resolveDefaultDiscordAccountId(params.cfg),
      eligibleAccountIds: isDiscordApprovalAccountEligible({ ...params, accountId })
        ? [accountId]
        : [],
    })
  ) {
    return false;
  }
  return isDiscordApprovalAccountEligible(params);
}
