import { resolveGroupAllowFromSources } from "openclaw/plugin-sdk/allow-from";
import type { ResolvedChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { resolveChannelGroups } from "openclaw/plugin-sdk/channel-policy";
import type { GroupPolicy, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { warnMissingProviderGroupPolicyFallbackOnce } from "openclaw/plugin-sdk/runtime-group-policy";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ResolvedZaloAccount, ZaloAccountConfig } from "./types.js";

export { resolveOpenProviderRuntimeGroupPolicy as resolveZaloRuntimeGroupPolicy } from "openclaw/plugin-sdk/runtime-group-policy";

const ZALO_ALLOW_FROM_PREFIX_RE = /^(zalo|zl):/i;

export function normalizeZaloAllowEntry(value: string): string {
  return value.trim().replace(ZALO_ALLOW_FROM_PREFIX_RE, "").trim().toLowerCase();
}

type ZaloGroups = NonNullable<ZaloAccountConfig["groups"]>;

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
  const { cfg, account, chatId, groupPolicy } = params;
  if (!params.isGroup || groupPolicy === "disabled") {
    return { senderGroupPolicy: groupPolicy };
  }
  // The shared resolver owns account inheritance, so gating and core per-group tool policy agree.
  // Entries keep the Zalo schema shape (`enabled`), which the shared ChannelGroups type omits.
  const groups: ZaloGroups = resolveChannelGroups(cfg, "zalo", account.accountId) ?? {};
  if (Object.keys(groups).length === 0) {
    return { senderGroupPolicy: groupPolicy };
  }
  const explicitEntry = Object.hasOwn(groups, chatId) ? groups[chatId] : undefined;
  const entry = explicitEntry ?? groups["*"];
  if (!entry) {
    return { drop: "not in groups" };
  }
  if (entry.enabled === false) {
    return { drop: "group disabled" };
  }
  const senderAllowlist = resolveGroupAllowFromSources({
    allowFrom: normalizeStringEntries(account.config.allowFrom),
    groupAllowFrom: normalizeStringEntries(account.config.groupAllowFrom),
    fallbackToAllowFrom: true,
  });
  return {
    senderGroupPolicy:
      groupPolicy === "allowlist" && explicitEntry && senderAllowlist.length === 0
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
