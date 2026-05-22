import { i as resolveOpenProviderRuntimeGroupPolicy } from "./runtime-group-policy-DO2R0ku6.js";
//#region extensions/whatsapp/src/runtime-group-policy.ts
function resolveWhatsAppRuntimeGroupPolicy(params) {
	return resolveOpenProviderRuntimeGroupPolicy({
		providerConfigPresent: params.providerConfigPresent,
		groupPolicy: params.groupPolicy,
		defaultGroupPolicy: params.defaultGroupPolicy
	});
}
//#endregion
export { resolveWhatsAppRuntimeGroupPolicy as t };
