import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { n as resolvePluginProviders } from "./providers.runtime-Bj4QRzbJ.js";
import { a as runProviderModelSelectedHook, n as resolveProviderModelPickerEntries, r as resolveProviderPluginChoice } from "./provider-wizard-CL7aBVWm.js";
import { t as sortFlowContributionsByLabel } from "./types-DZV4ilD2.js";
import { n as runProviderPluginAuthMethod } from "./provider-auth-choice-B3J-7cr7.js";
//#region src/flows/provider-flow.runtime.ts
function resolveProviderDocsById(params) {
	return new Map(resolvePluginProviders({
		config: params?.config,
		workspaceDir: params?.workspaceDir,
		env: params?.env,
		mode: "setup"
	}).filter((provider) => Boolean(normalizeOptionalString(provider.docsPath))).map((provider) => [provider.id, normalizeOptionalString(provider.docsPath)]));
}
function resolveProviderModelPickerFlowEntries(params) {
	return resolveProviderModelPickerFlowContributions(params).map((contribution) => contribution.option);
}
function resolveProviderModelPickerFlowContributions(params) {
	const docsByProvider = resolveProviderDocsById(params ?? {});
	return sortFlowContributionsByLabel(resolveProviderModelPickerEntries(params ?? {}).map((entry) => {
		const providerId = entry.value.startsWith("provider-plugin:") ? entry.value.slice(16).split(":")[0] : entry.value;
		return {
			id: `provider:model-picker:${entry.value}`,
			kind: "provider",
			surface: "model-picker",
			providerId,
			option: {
				value: entry.value,
				label: entry.label,
				...entry.hint ? { hint: entry.hint } : {},
				...docsByProvider.get(providerId) ? { docs: { path: docsByProvider.get(providerId) } } : {}
			},
			source: "runtime"
		};
	}));
}
//#endregion
//#region src/commands/model-picker.runtime.ts
const modelPickerRuntime = {
	resolveProviderModelPickerContributions: resolveProviderModelPickerFlowContributions,
	resolveProviderModelPickerEntries: resolveProviderModelPickerFlowEntries,
	resolveProviderPluginChoice,
	runProviderModelSelectedHook,
	resolvePluginProviders,
	runProviderPluginAuthMethod
};
//#endregion
export { modelPickerRuntime };
