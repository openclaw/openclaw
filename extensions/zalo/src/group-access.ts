import type { GroupPolicy, SenderGroupAccessDecision } from "openclaw/plugin-sdk";
import {
  evaluateSenderGroupAccess,
  isNormalizedSenderAllowed,
  resolveOpenProviderRuntimeGroupPolicy,
} from "openclaw/plugin-sdk";

const ZALO_ALLOW_FROM_PREFIX_RE = /^(zalo|zl):/i;

export function isZaloSenderAllowed(senderId: string, allowFrom: string[]): boolean {
  return isNormalizedSenderAllowed({
    senderId,
    allowFrom,
    stripPrefixRe: ZALO_ALLOW_FROM_PREFIX_RE,
  });
}

export function resolveZaloRuntimeGroupPolicy(params: {
  providerConfigPresent: boolean;
  groupPolicy?: GroupPolicy;
  defaultGroupPolicy?: GroupPolicy;
}): {
  groupPolicy: GroupPolicy;
  providerMissingFallbackApplied: boolean;
} {
  return resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent: params.providerConfigPresent,
    groupPolicy: params.groupPolicy,
    defaultGroupPolicy: params.defaultGroupPolicy,
  });
}

export function evaluateZaloGroupAccess(params: {
  providerConfigPresent: boolean;
  configuredGroupPolicy?: GroupPolicy;
  defaultGroupPolicy?: GroupPolicy;
  groupAllowFrom: string[];
  senderId: string;
}): SenderGroupAccessDecision {
  return evaluateSenderGroupAccess({
    providerConfigPresent: params.providerConfigPresent,
    configuredGroupPolicy: params.configuredGroupPolicy,
    defaultGroupPolicy: params.defaultGroupPolicy,
    groupAllowFrom: params.groupAllowFrom,
    senderId: params.senderId,
    isSenderAllowed: isZaloSenderAllowed,
  });
}
