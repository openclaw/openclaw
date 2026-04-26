import {
  resolveDefaultGroupPolicy,
  type DmPolicy,
  type GroupPolicy,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/config-runtime";
import { resolveEffectiveAllowFromLists } from "openclaw/plugin-sdk/security-runtime";
import { resolveWhatsAppAccount, type ResolvedWhatsAppAccount } from "./accounts.js";
import {
  resolveWhatsAppOutboundTarget,
  type WhatsAppOutboundTargetResolution,
} from "./resolve-outbound-target.js";
import { resolveWhatsAppRuntimeGroupPolicy } from "./runtime-group-policy.js";
import { isSelfChatMode, normalizeE164 } from "./text-runtime.js";

export type ResolvedWhatsAppAccountPolicy = {
  account: ResolvedWhatsAppAccount;
  accountId: string;
  dmPolicy: DmPolicy;
  groupPolicy: GroupPolicy;
  configuredAllowFrom: string[];
  dmAllowFrom: string[];
  groupAllowFrom: string[];
  isSelfChat: boolean;
  providerMissingFallbackApplied: boolean;
  shouldReadStorePairingApprovals: boolean;
  isSamePhone: (value?: string | null) => boolean;
  isDmSenderAllowed: (allowEntries: string[], sender?: string | null) => boolean;
  isGroupSenderAllowed: (allowEntries: string[], sender?: string | null) => boolean;
};

function normalizeConfiguredAllowEntries(entries?: Array<string | number> | null): string[] {
  return (entries ?? []).map((entry) => String(entry).trim()).filter(Boolean);
}

function isNormalizedSenderAllowed(allowEntries: string[], sender?: string | null): boolean {
  if (allowEntries.includes("*")) {
    return true;
  }
  const normalizedSender = normalizeE164(sender ?? "");
  if (!normalizedSender) {
    return false;
  }
  const normalizedEntrySet = new Set(
    allowEntries
      .map((entry) => normalizeE164(entry))
      .filter((entry): entry is string => Boolean(entry)),
  );
  return normalizedEntrySet.has(normalizedSender);
}

export function resolveWhatsAppAccountPolicy(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  selfE164?: string | null;
}): ResolvedWhatsAppAccountPolicy {
  const account = resolveWhatsAppAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const configuredAllowFrom = normalizeConfiguredAllowEntries(account.allowFrom);
  const dmPolicy = account.dmPolicy ?? "pairing";
  const dmAllowFrom =
    configuredAllowFrom.length > 0 ? configuredAllowFrom : params.selfE164 ? [params.selfE164] : [];
  const configuredGroupAllowFrom = normalizeConfiguredAllowEntries(account.groupAllowFrom);
  const { effectiveGroupAllowFrom } = resolveEffectiveAllowFromLists({
    allowFrom: configuredAllowFrom,
    groupAllowFrom: configuredGroupAllowFrom,
  });
  const defaultGroupPolicy = resolveDefaultGroupPolicy(params.cfg);
  const { groupPolicy, providerMissingFallbackApplied } = resolveWhatsAppRuntimeGroupPolicy({
    providerConfigPresent: params.cfg.channels?.whatsapp !== undefined,
    groupPolicy: account.groupPolicy,
    defaultGroupPolicy,
  });
  const isSamePhone = (value?: string | null) =>
    typeof value === "string" && typeof params.selfE164 === "string" && value === params.selfE164;
  return {
    account,
    accountId: account.accountId,
    dmPolicy,
    groupPolicy,
    configuredAllowFrom,
    dmAllowFrom,
    groupAllowFrom: effectiveGroupAllowFrom,
    isSelfChat: account.selfChatMode ?? isSelfChatMode(params.selfE164, configuredAllowFrom),
    providerMissingFallbackApplied,
    shouldReadStorePairingApprovals: dmPolicy !== "allowlist",
    isSamePhone,
    isDmSenderAllowed: (allowEntries, sender) =>
      isSamePhone(sender) || isNormalizedSenderAllowed(allowEntries, sender),
    isGroupSenderAllowed: (allowEntries, sender) => isNormalizedSenderAllowed(allowEntries, sender),
  };
}

export function resolveWhatsAppDirectTargetAuthorization(params: {
  cfg: OpenClawConfig;
  to: string;
  accountId?: string | null;
  mode?: string | null;
}): {
  account: ResolvedWhatsAppAccount;
  accountId: string;
  resolution: WhatsAppOutboundTargetResolution;
} {
  const policy = resolveWhatsAppAccountPolicy({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  return {
    account: policy.account,
    accountId: policy.accountId,
    resolution: resolveWhatsAppOutboundTarget({
      to: params.to,
      allowFrom: policy.configuredAllowFrom,
      mode: params.mode ?? "implicit",
    }),
  };
}
