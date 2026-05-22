import { i as resolveOpenProviderRuntimeGroupPolicy } from "./runtime-group-policy-B7GObW62.js";
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
