import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
//#region src/plugin-sdk/provider-selection-runtime.ts
function selectConfiguredOrAutoProvider(params) {
	const configuredProviderId = normalizeOptionalString(params.configuredProviderId);
	const configuredProvider = configuredProviderId ? params.getConfiguredProvider(configuredProviderId) : void 0;
	if (configuredProviderId && !configuredProvider) return {
		configuredProviderId,
		missingConfiguredProvider: true,
		provider: void 0
	};
	return {
		configuredProviderId,
		missingConfiguredProvider: false,
		provider: configuredProvider ?? [...params.listProviders()].toSorted(compareProviderAutoSelectOrder)[0]
	};
}
function resolveProviderRawConfig(params) {
	const canonicalProviderConfig = readProviderConfig(params.providerConfigs, params.providerId);
	const selectedProviderConfig = readProviderConfig(params.providerConfigs, params.configuredProviderId);
	return {
		...canonicalProviderConfig,
		...selectedProviderConfig
	};
}
function resolveConfiguredCapabilityProvider(params) {
	const configuredProviderId = normalizeOptionalString(params.configuredProviderId);
	if (configuredProviderId) {
		const provider = params.getConfiguredProvider(configuredProviderId);
		if (!provider) return {
			ok: false,
			code: "missing-configured-provider",
			configuredProviderId
		};
		return resolveProviderCandidate({
			...params,
			configuredProviderId,
			provider
		});
	}
	const providers = [...params.listProviders()].toSorted(compareProviderAutoSelectOrder);
	if (providers.length === 0) return {
		ok: false,
		code: "no-registered-provider"
	};
	let firstUnconfigured;
	for (const provider of providers) {
		const resolution = resolveProviderCandidate({
			...params,
			provider
		});
		if (resolution.ok) return resolution;
		firstUnconfigured ??= provider;
	}
	return {
		ok: false,
		code: "provider-not-configured",
		provider: firstUnconfigured
	};
}
function compareProviderAutoSelectOrder(left, right) {
	return (left.autoSelectOrder ?? Number.MAX_SAFE_INTEGER) - (right.autoSelectOrder ?? Number.MAX_SAFE_INTEGER);
}
function readProviderConfig(providerConfigs, providerId) {
	if (!providerId) return;
	const providerConfig = providerConfigs?.[providerId];
	return providerConfig && typeof providerConfig === "object" ? providerConfig : void 0;
}
function resolveProviderCandidate(params) {
	const rawProviderConfig = resolveProviderRawConfig({
		providerId: params.provider.id,
		configuredProviderId: params.configuredProviderId,
		providerConfigs: params.providerConfigs
	});
	const providerConfig = params.resolveProviderConfig({
		provider: params.provider,
		cfg: params.cfgForResolve,
		rawConfig: rawProviderConfig
	});
	if (!params.isProviderConfigured({
		provider: params.provider,
		cfg: params.cfg,
		providerConfig
	})) return {
		ok: false,
		code: "provider-not-configured",
		configuredProviderId: params.configuredProviderId,
		provider: params.provider
	};
	return {
		ok: true,
		configuredProviderId: params.configuredProviderId,
		provider: params.provider,
		providerConfig
	};
}
//#endregion
export { resolveProviderRawConfig as n, selectConfiguredOrAutoProvider as r, resolveConfiguredCapabilityProvider as t };
