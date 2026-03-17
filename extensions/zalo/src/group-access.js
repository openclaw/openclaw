import {
  evaluateSenderGroupAccess,
  isNormalizedSenderAllowed,
  resolveOpenProviderRuntimeGroupPolicy
} from "openclaw/plugin-sdk/zalo";
const ZALO_ALLOW_FROM_PREFIX_RE = /^(zalo|zl):/i;
function isZaloSenderAllowed(senderId, allowFrom) {
  return isNormalizedSenderAllowed({
    senderId,
    allowFrom,
    stripPrefixRe: ZALO_ALLOW_FROM_PREFIX_RE
  });
}
function resolveZaloRuntimeGroupPolicy(params) {
  return resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent: params.providerConfigPresent,
    groupPolicy: params.groupPolicy,
    defaultGroupPolicy: params.defaultGroupPolicy
  });
}
function evaluateZaloGroupAccess(params) {
  return evaluateSenderGroupAccess({
    providerConfigPresent: params.providerConfigPresent,
    configuredGroupPolicy: params.configuredGroupPolicy,
    defaultGroupPolicy: params.defaultGroupPolicy,
    groupAllowFrom: params.groupAllowFrom,
    senderId: params.senderId,
    isSenderAllowed: isZaloSenderAllowed
  });
}
export {
  evaluateZaloGroupAccess,
  isZaloSenderAllowed,
  resolveZaloRuntimeGroupPolicy
};
