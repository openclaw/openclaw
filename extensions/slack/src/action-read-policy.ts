import { normalizeAccountId } from "openclaw/plugin-sdk/account-resolution";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { resolveOpenProviderRuntimeGroupPolicy } from "openclaw/plugin-sdk/runtime-group-policy";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ResolvedSlackAccount } from "./accounts.js";
import type { SlackActionContext } from "./action-context.js";
import type { SlackConversationInfo } from "./channel-type.js";
import { buildSlackChannelIdCandidates, hasPotentialSlackNamedPolicy } from "./group-policy.js";
import { getSlackInstallationKind } from "./installation-identity-state.js";
import { resolveSlackChannelConfig } from "./monitor/channel-config.js";
import { isSlackChannelAllowedByPolicy } from "./monitor/policy.js";
import { parseSlackTarget, slackContextTargetsMatch } from "./targets.js";

type ConversationReadInvocationOrigin = NonNullable<
  ChannelMessageActionContext["conversationReadOrigin"]
>;

const loadSlackAccountsRuntime = createLazyRuntimeModule(() => import("./accounts.js"));

export function resolveSlackDmReadAllowed(account: ResolvedSlackAccount): boolean {
  const dmPolicy = account.config.dmPolicy ?? "pairing";
  return account.config.dm?.enabled !== false && dmPolicy !== "disabled";
}

function normalizeConfiguredSlackDmUserId(value: unknown): string | undefined {
  const target = parseSlackTarget(String(value), { defaultKind: "user" });
  if (target?.kind !== "user") {
    return undefined;
  }
  const userId = target.id.trim().toLowerCase();
  return /^[uw][a-z0-9]+$/i.test(userId) ? userId : undefined;
}

export async function isSlackDmTargetConfigured(params: {
  account: ResolvedSlackAccount;
  cfg: OpenClawConfig;
  channelId: string;
  userId?: string;
}): Promise<boolean> {
  const defaultTo = params.account.config.defaultTo?.trim();
  if (
    defaultTo &&
    slackContextTargetsMatch(params.channelId, {
      currentChannelId: defaultTo,
    })
  ) {
    return true;
  }
  const userId = normalizeConfiguredSlackDmUserId(params.userId);
  if (!userId) {
    return false;
  }
  const { resolveSlackAccountAllowFrom } = await loadSlackAccountsRuntime();
  const configuredUsers = [
    ...(resolveSlackAccountAllowFrom({
      cfg: params.cfg,
      accountId: params.account.accountId,
    }) ?? []),
    ...Object.keys(params.account.config.dms ?? {}),
    ...(defaultTo ? [defaultTo] : []),
  ];
  return configuredUsers.some((entry) => normalizeConfiguredSlackDmUserId(entry) === userId);
}

export function hasSlackRequesterAccount(
  account: ResolvedSlackAccount,
  context?: SlackActionContext,
) {
  const requesterAccountId = context?.requesterAccountId?.trim();
  return Boolean(
    normalizeOptionalLowercaseString(context?.currentChannelProvider) === "slack" &&
    requesterAccountId &&
    normalizeAccountId(requesterAccountId) === normalizeAccountId(account.accountId),
  );
}

export function resolveSlackChannelReadPolicy(params: {
  account: ResolvedSlackAccount;
  cfg: OpenClawConfig;
  channelId: string;
  teamId?: string;
  channelName?: string;
  conversationReadOrigin?: ConversationReadInvocationOrigin;
  metadataResolved?: boolean;
  currentConversation?: boolean;
}) {
  const channels = params.account.config.channels;
  const channelKeys = Object.keys(channels ?? {});
  const channelConfig = resolveSlackChannelConfig({
    teamId: params.teamId,
    allowUnscoped: getSlackInstallationKind(params.account.accountId) !== "enterprise",
    channelId: params.channelId,
    channelName: params.channelName,
    channels,
    channelKeys,
    allowNameMatching: params.account.config.dangerouslyAllowNameMatching,
    defaultRequireMention: params.account.config.requireMention,
  });
  const channelAllowed = channelConfig?.allowed !== false;
  const channelExplicitlyDisabled = !channelAllowed && channelConfig?.matchSource === "direct";
  const channelWildcardDisabled = !channelAllowed && channelConfig?.matchSource === "wildcard";
  const { groupPolicy } = resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent: params.cfg.channels?.slack !== undefined,
    groupPolicy: params.account.config.groupPolicy,
    defaultGroupPolicy: params.cfg.channels?.defaults?.groupPolicy,
  });
  const policyAllowed = isSlackChannelAllowedByPolicy({
    groupPolicy,
    channelAllowlistConfigured: channelKeys.length > 0,
    channelAllowed,
  });
  const delegatedChannelAllowed =
    policyAllowed && !(!channelAllowed && (groupPolicy !== "open" || channelConfig?.matchSource));
  const directChannelAllowed =
    groupPolicy !== "disabled" && !channelExplicitlyDisabled && !channelWildcardDisabled;
  const baseChannelAllowed =
    params.conversationReadOrigin === "direct-operator" || params.currentConversation
      ? directChannelAllowed
      : delegatedChannelAllowed;
  const allowNameMatching = params.account.config.dangerouslyAllowNameMatching;
  const shouldResolveName =
    !params.metadataResolved &&
    !params.channelName &&
    ((baseChannelAllowed &&
      channelConfig?.matchSource !== "direct" &&
      hasPotentialSlackNamedPolicy({
        channels,
        allowNameMatching,
        decision: "deny",
      })) ||
      (!baseChannelAllowed &&
        groupPolicy !== "disabled" &&
        !channelExplicitlyDisabled &&
        hasPotentialSlackNamedPolicy({
          channels,
          allowNameMatching,
          decision: "allow",
        })));
  return {
    channelAllowed: baseChannelAllowed,
    channelExplicitlyDisabled,
    groupDmAllowed:
      params.account.config.dm?.enabled !== false &&
      params.account.config.dm?.groupEnabled === true &&
      (params.currentConversation ||
        isSlackGroupDmTargetConfigured(params.account, params.channelId, params.teamId)),
    shouldResolveName,
  };
}

export async function isSlackResolvedReadTargetAllowed(params: {
  account: ResolvedSlackAccount;
  cfg: OpenClawConfig;
  channelId: string;
  teamId?: string;
  conversationReadOrigin?: ConversationReadInvocationOrigin;
  info: SlackConversationInfo;
  currentConversation: boolean;
}): Promise<boolean> {
  const { info } = params;
  const resolved = resolveSlackChannelReadPolicy({
    ...params,
    channelName: info.name,
    metadataResolved: true,
  });
  if (resolved.channelExplicitlyDisabled) {
    return false;
  }
  if (info.type === "dm") {
    return (
      resolveSlackDmReadAllowed(params.account) &&
      (params.conversationReadOrigin === "direct-operator" ||
        params.currentConversation ||
        (await isSlackDmTargetConfigured({ ...params, userId: info.user })))
    );
  }
  return info.type === "channel"
    ? resolved.channelAllowed
    : info.type === "group"
      ? resolved.groupDmAllowed
      : resolved.channelAllowed && resolved.groupDmAllowed;
}

function isSlackGroupDmTargetConfigured(
  account: ResolvedSlackAccount,
  channelId: string,
  teamId?: string,
): boolean {
  const entries = account.config.dm?.groupChannels ?? [];
  if (entries.length === 0) {
    return true;
  }
  const candidates = new Set(
    buildSlackChannelIdCandidates(channelId, teamId, {
      allowUnscoped: getSlackInstallationKind(account.accountId) !== "enterprise",
    }).map((candidate) => candidate.toLowerCase()),
  );
  const target = channelId.trim().toLowerCase();
  return entries.some((entry) => {
    const candidate = String(entry).trim().toLowerCase();
    return (
      candidate === "*" ||
      candidates.has(candidate) ||
      candidate === target ||
      candidate === `slack:${target}` ||
      candidate === `channel:${target}` ||
      candidate === `group:${target}` ||
      candidate === `mpim:${target}`
    );
  });
}

/** Whether any policy entry is qualified by workspace, so unqualified reads need one. */
export function hasSlackTeamScopedPolicy(account: ResolvedSlackAccount): boolean {
  return [
    ...Object.keys(account.config.channels ?? {}),
    ...(account.config.dm?.groupChannels ?? []).map(String),
  ].some((key) => /^team:/i.test(key.trim()));
}
