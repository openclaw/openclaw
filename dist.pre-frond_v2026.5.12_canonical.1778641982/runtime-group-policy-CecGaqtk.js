import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
//#region src/config/runtime-group-policy.ts
function resolveRuntimeGroupPolicy(params) {
	const configuredFallbackPolicy = params.configuredFallbackPolicy ?? "open";
	const missingProviderFallbackPolicy = params.missingProviderFallbackPolicy ?? "allowlist";
	return {
		groupPolicy: params.providerConfigPresent ? params.groupPolicy ?? params.defaultGroupPolicy ?? configuredFallbackPolicy : params.groupPolicy ?? missingProviderFallbackPolicy,
		providerMissingFallbackApplied: !params.providerConfigPresent && params.groupPolicy === void 0
	};
}
function resolveDefaultGroupPolicy(cfg) {
	return cfg.channels?.defaults?.groupPolicy;
}
const GROUP_POLICY_BLOCKED_LABEL = {
	group: "group messages",
	guild: "guild messages",
	room: "room messages",
	channel: "channel messages",
	space: "space messages"
};
/**
* Standard provider runtime policy:
* - configured provider fallback: open
* - missing provider fallback: allowlist (fail-closed)
*/
function resolveOpenProviderRuntimeGroupPolicy(params) {
	return resolveRuntimeGroupPolicy({
		providerConfigPresent: params.providerConfigPresent,
		groupPolicy: params.groupPolicy,
		defaultGroupPolicy: params.defaultGroupPolicy,
		configuredFallbackPolicy: "open",
		missingProviderFallbackPolicy: "allowlist"
	});
}
/**
* Strict provider runtime policy:
* - configured provider fallback: allowlist
* - missing provider fallback: allowlist (fail-closed)
*/
function resolveAllowlistProviderRuntimeGroupPolicy(params) {
	return resolveRuntimeGroupPolicy({
		providerConfigPresent: params.providerConfigPresent,
		groupPolicy: params.groupPolicy,
		defaultGroupPolicy: params.defaultGroupPolicy,
		configuredFallbackPolicy: "allowlist",
		missingProviderFallbackPolicy: "allowlist"
	});
}
const warnedMissingProviderGroupPolicy = /* @__PURE__ */ new Set();
function warnMissingProviderGroupPolicyFallbackOnce(params) {
	if (!params.providerMissingFallbackApplied) return false;
	const key = `${params.providerKey}:${params.accountId ?? "*"}`;
	if (warnedMissingProviderGroupPolicy.has(key)) return false;
	warnedMissingProviderGroupPolicy.add(key);
	const blockedLabel = normalizeOptionalString(params.blockedLabel) || "group messages";
	params.log(`${params.providerKey}: channels.${params.providerKey} is missing; defaulting groupPolicy to "allowlist" (${blockedLabel} blocked until explicitly configured).`);
	return true;
}
//#endregion
export { warnMissingProviderGroupPolicyFallbackOnce as a, resolveOpenProviderRuntimeGroupPolicy as i, resolveAllowlistProviderRuntimeGroupPolicy as n, resolveDefaultGroupPolicy as r, GROUP_POLICY_BLOCKED_LABEL as t };
