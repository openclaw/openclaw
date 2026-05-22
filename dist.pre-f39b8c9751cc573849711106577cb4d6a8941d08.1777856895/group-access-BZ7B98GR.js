import { i as isNormalizedSenderAllowed } from "./allow-from-95hK47_c.js";
import { i as resolveOpenProviderRuntimeGroupPolicy } from "./runtime-group-policy-DO2R0ku6.js";
import { r as evaluateSenderGroupAccess } from "./group-access-Dr35xRX9.js";
//#region extensions/zalo/src/group-access.ts
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
//#endregion
export { isZaloSenderAllowed as n, resolveZaloRuntimeGroupPolicy as r, evaluateZaloGroupAccess as t };
