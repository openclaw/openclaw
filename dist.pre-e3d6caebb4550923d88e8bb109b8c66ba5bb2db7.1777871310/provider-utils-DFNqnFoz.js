import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-Bje8XVt9.js";
import { A as resolveProviderReasoningOutputModeWithPlugin } from "./provider-runtime-7ACeYwey.js";
//#region src/utils/provider-utils.ts
const BUILTIN_REASONING_OUTPUT_MODES = { "google-generative-ai": "tagged" };
/**
* Utility functions for provider-specific logic and capabilities.
*/
function resolveReasoningOutputMode(params) {
	const provider = normalizeOptionalString(params.provider);
	if (!provider) return "native";
	const normalized = normalizeOptionalLowercaseString(provider) ?? "";
	const pluginMode = resolveProviderReasoningOutputModeWithPlugin({
		provider,
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env,
		context: {
			config: params.config,
			workspaceDir: params.workspaceDir,
			env: params.env,
			provider,
			modelId: params.modelId,
			modelApi: params.modelApi,
			model: params.model
		}
	});
	if (pluginMode) return pluginMode;
	const builtInMode = BUILTIN_REASONING_OUTPUT_MODES[normalized];
	if (builtInMode) return builtInMode;
	return "native";
}
/**
* Returns true if the provider requires reasoning to be wrapped in tags
* (e.g. <think> and <final>) in the text stream, rather than using native
* API fields for reasoning/thinking.
*/
function isReasoningTagProvider(provider, options) {
	return resolveReasoningOutputMode({
		provider,
		config: options?.config,
		workspaceDir: options?.workspaceDir,
		env: options?.env,
		modelId: options?.modelId,
		modelApi: options?.modelApi,
		model: options?.model
	}) === "tagged";
}
//#endregion
export { isReasoningTagProvider as t };
