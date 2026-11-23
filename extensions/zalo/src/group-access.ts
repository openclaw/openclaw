import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { resolveGroupAllowFromSources } from "openclaw/plugin-sdk/allow-from";
import type { ChannelGroupContext } from "openclaw/plugin-sdk/channel-contract";
import type { ResolvedChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import {
  buildChannelGroupsScopeTree,
  resolveChannelGroupToolsPolicy,
  resolveScopeKeyCaseInsensitive,
} from "openclaw/plugin-sdk/channel-policy";
import type { GroupPolicy, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { warnMissingProviderGroupPolicyFallbackOnce } from "openclaw/plugin-sdk/runtime-group-policy";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ResolvedZaloAccount } from "./types.js";

export { resolveOpenProviderRuntimeGroupPolicy as resolveZaloRuntimeGroupPolicy } from "openclaw/plugin-sdk/runtime-group-policy";

const ZALO_ALLOW_FROM_PREFIX_RE = /^(zalo|zl):/i;

export function normalizeZaloAllowEntry(value: string): string {
  return value.trim().replace(ZALO_ALLOW_FROM_PREFIX_RE, "").trim().toLowerCase();
}

/** `enabled: false` turns an entry off; entries are read from the shared, loosely typed map. */
function isZaloGroupEntryEnabled(entry: unknown): boolean {
  return !(
    typeof entry === "object" &&
    entry !== null &&
    "enabled" in entry &&
    entry.enabled === false
  );
}

/**
 * Find the `groups` entry for a group id. The shared resolver owns account inheritance, and keys
 * match case-insensitively because session keys, and so core's per-group tool lookup, lowercase ids.
 */
function findZaloGroupEntry(cfg: OpenClawConfig, accountId: string, groupId: string) {
  const tree = buildChannelGroupsScopeTree(cfg, "zalo", accountId);
  const key = resolveScopeKeyCaseInsensitive(tree, groupId);
  const explicit = key ? tree.scopes[key] : undefined;
  return {
    configured: Object.keys(tree.scopes).length > 0 || tree.defaults !== undefined,
    explicit,
    entry: explicit ?? tree.defaults,
  };
}

/** Per-group tool policy, looked up with the same case-insensitive matching as admission. */
export function resolveZaloGroupToolPolicy(params: ChannelGroupContext) {
  return resolveChannelGroupToolsPolicy({
    cfg: params.cfg,
    channel: "zalo",
    groupId: params.groupId,
    accountId: params.accountId,
    groupIdCaseInsensitive: true,
  });
}

/**
 * Doctor: a group allowlisted by id admits its members without a sender allowlist, so the
 * shared "all group messages will be dropped" warning would be wrong for that account.
 */
export function hasZaloGroupAllowlistedById(params: {
  channelName: string;
  account: Record<string, unknown>;
  parent?: Record<string, unknown>;
  prefix: string;
}): boolean {
  if (params.channelName !== "zalo") {
    return false;
  }
  const accountPrefix = "channels.zalo.accounts.";
  const accountId = params.prefix.startsWith(accountPrefix)
    ? params.prefix.slice(accountPrefix.length)
    : DEFAULT_ACCOUNT_ID;
  // SAFETY: doctor passes the raw channel record that this plugin's config schema validated.
  const zalo = (params.parent ?? params.account) as NonNullable<OpenClawConfig["channels"]>["zalo"];
  const tree = buildChannelGroupsScopeTree({ channels: { zalo } }, "zalo", accountId);
  return Object.values(tree.scopes).some(isZaloGroupEntryEnabled);
}

/**
 * Apply the `groups` map before sender checks, with Telegram's layering: a non-empty map
 * restricts which groups are admitted, and a group listed by id admits any member when no
 * sender allowlist is in effect. Returns the group policy for the sender gate, or a drop reason.
 */
export function resolveZaloGroupAdmission(params: {
  cfg: OpenClawConfig;
  account: ResolvedZaloAccount;
  isGroup: boolean;
  chatId: string;
  groupPolicy: GroupPolicy;
}): { senderGroupPolicy: GroupPolicy } | { drop: string } {
  const { account, groupPolicy } = params;
  if (!params.isGroup || groupPolicy === "disabled") {
    return { senderGroupPolicy: groupPolicy };
  }
  const { configured, explicit, entry } = findZaloGroupEntry(
    params.cfg,
    account.accountId,
    params.chatId,
  );
  if (!configured) {
    return { senderGroupPolicy: groupPolicy };
  }
  if (!entry) {
    return { drop: "not in groups" };
  }
  if (!isZaloGroupEntryEnabled(entry)) {
    return { drop: "group disabled" };
  }
  const senderAllowlist = resolveGroupAllowFromSources({
    allowFrom: normalizeStringEntries(account.config.allowFrom),
    groupAllowFrom: normalizeStringEntries(account.config.groupAllowFrom),
    fallbackToAllowFrom: true,
  });
  return {
    senderGroupPolicy:
      groupPolicy === "allowlist" && explicit && senderAllowlist.length === 0
        ? "open"
        : groupPolicy,
  };
}

/** Report the shared sender gate result for a group message; returns whether it may proceed. */
export function admitZaloGroupSender(params: {
  senderAccess: Pick<
    ResolvedChannelMessageIngress["senderAccess"],
    "allowed" | "reasonCode" | "providerMissingFallbackApplied"
  >;
  account: ResolvedZaloAccount;
  chatId: string;
  senderId: string;
  log: (message: string) => void;
}): boolean {
  const { senderAccess, chatId, senderId, log } = params;
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied: senderAccess.providerMissingFallbackApplied,
    providerKey: "zalo",
    accountId: params.account.accountId,
    log,
  });
  if (senderAccess.allowed) {
    return true;
  }
  if (senderAccess.reasonCode === "group_policy_disabled") {
    log(`zalo: drop group ${chatId} (groupPolicy=disabled)`);
  } else if (senderAccess.reasonCode === "group_policy_empty_allowlist") {
    log(`zalo: drop group ${chatId} (groupPolicy=allowlist, no sender allowlist for this group)`);
  } else if (senderAccess.reasonCode === "group_policy_not_allowlisted") {
    log(`zalo: drop group sender ${senderId} (groupPolicy=allowlist)`);
  }
  return false;
}
