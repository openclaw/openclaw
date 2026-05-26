import { d as normalizeSecretInputString, m as resolveSecretInputRef } from "./types.secrets-DwPik3M8.js";
import { n as normalizeSecretInput } from "./normalize-secret-input-CsdRhsMj.js";
//#region src/web/provider-runtime-shared.ts
function resolveWebProviderConfig(cfg, kind) {
	const webConfig = cfg?.tools?.web;
	if (!webConfig || typeof webConfig !== "object") return;
	const toolConfig = webConfig[kind];
	if (!toolConfig || typeof toolConfig !== "object") return;
	return toolConfig;
}
function readWebProviderEnvValue(envVars, processEnv = process.env) {
	for (const envVar of envVars) {
		const value = normalizeSecretInput(processEnv[envVar]);
		if (value) return value;
	}
}
function providerRequiresCredential(provider) {
	return provider.requiresCredential !== false;
}
function hasWebProviderEntryCredential(params) {
	if (!providerRequiresCredential(params.provider)) return true;
	const rawValue = params.resolveRawValue({
		provider: params.provider,
		config: params.config,
		toolConfig: params.toolConfig
	});
	const configuredRef = resolveSecretInputRef({ value: rawValue }).ref;
	if (configuredRef && configuredRef.source !== "env") return true;
	if (normalizeSecretInput(normalizeSecretInputString(rawValue))) return true;
	if (params.provider.authProviderId && params.resolveProviderAuthValue?.(params.provider.authProviderId)) return true;
	if (params.resolveEnvValue({
		provider: params.provider,
		configuredEnvVarId: configuredRef?.source === "env" ? configuredRef.id : void 0
	})) return true;
	const fallbackRawValue = params.resolveFallbackRawValue?.({
		provider: params.provider,
		config: params.config,
		toolConfig: params.toolConfig
	});
	const fallbackRef = resolveSecretInputRef({ value: fallbackRawValue }).ref;
	if (fallbackRef && fallbackRef.source !== "env") return true;
	if (normalizeSecretInput(normalizeSecretInputString(fallbackRawValue))) return true;
	return Boolean(fallbackRef?.source === "env" ? params.resolveEnvValue({
		provider: params.provider,
		configuredEnvVarId: fallbackRef.id
	}) : void 0);
}
function resolveWebProviderDefinition(params) {
	if (!params.resolveEnabled({
		toolConfig: params.toolConfig,
		sandboxed: params.sandboxed
	})) return null;
	const providers = params.providers.filter(Boolean);
	if (providers.length === 0) return null;
	const autoProviderId = params.resolveAutoProviderId({
		config: params.config,
		toolConfig: params.toolConfig,
		providers
	});
	const providerId = params.providerId ?? params.runtimeMetadata?.selectedProvider ?? autoProviderId;
	if (!providerId) return null;
	const provider = providers.find((entry) => entry.id === providerId) ?? providers.find((entry) => entry.id === params.resolveFallbackProviderId?.({
		config: params.config,
		toolConfig: params.toolConfig,
		providers,
		providerId
	}));
	if (!provider) return null;
	const definition = params.createTool({
		provider,
		config: params.config,
		toolConfig: params.toolConfig,
		runtimeMetadata: params.runtimeMetadata
	});
	if (!definition) return null;
	return {
		provider,
		definition
	};
}
//#endregion
export { resolveWebProviderDefinition as a, resolveWebProviderConfig as i, providerRequiresCredential as n, readWebProviderEnvValue as r, hasWebProviderEntryCredential as t };
