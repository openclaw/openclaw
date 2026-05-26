import { i as resolveOpenProviderRuntimeGroupPolicy } from "./runtime-group-policy-CmZDlIwd.js";
//#region extensions/zalo/src/group-access.ts
const ZALO_ALLOW_FROM_PREFIX_RE = /^(zalo|zl):/i;
function normalizeZaloAllowEntry(value) {
	return value.trim().replace(ZALO_ALLOW_FROM_PREFIX_RE, "").trim().toLowerCase();
}
function resolveZaloRuntimeGroupPolicy(params) {
	return resolveOpenProviderRuntimeGroupPolicy({
		providerConfigPresent: params.providerConfigPresent,
		groupPolicy: params.groupPolicy,
		defaultGroupPolicy: params.defaultGroupPolicy
	});
}
//#endregion
export { resolveZaloRuntimeGroupPolicy as n, normalizeZaloAllowEntry as t };
