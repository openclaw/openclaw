import { t as getActiveRuntimePluginRegistry } from "./active-runtime-registry-wEpAEHY2.js";
import { n as resolvePluginCapabilityProvider, r as resolvePluginCapabilityProviders } from "./capability-provider-runtime-BwiWIvn0.js";
import { n as normalizeCapabilityProviderId, t as buildCapabilityProviderMaps } from "./provider-registry-shared-BvRrJpZ_.js";
//#region src/tts/provider-registry-core.ts
function normalizeSpeechProviderId(providerId) {
	return normalizeCapabilityProviderId(providerId);
}
function createSpeechProviderRegistry(resolver) {
	const buildResolvedProviderMaps = (cfg) => buildCapabilityProviderMaps(resolver.listProviders(cfg));
	const listProviders = (cfg) => [...buildResolvedProviderMaps(cfg).canonical.values()];
	const getProvider = (providerId, cfg) => {
		const normalized = normalizeSpeechProviderId(providerId);
		if (!normalized) return;
		return resolver.getProvider(normalized, cfg) ?? buildResolvedProviderMaps(cfg).aliases.get(normalized);
	};
	const canonicalizeProviderId = (providerId, cfg) => {
		const normalized = normalizeSpeechProviderId(providerId);
		if (!normalized) return;
		return getProvider(normalized, cfg)?.id ?? normalized;
	};
	return {
		canonicalizeSpeechProviderId: canonicalizeProviderId,
		getSpeechProvider: getProvider,
		listSpeechProviders: listProviders
	};
}
//#endregion
//#region src/tts/provider-registry.ts
function resolveSpeechProviderPluginEntries(cfg) {
	return resolvePluginCapabilityProviders({
		key: "speechProviders",
		cfg
	});
}
function resolveLoadedSpeechProviderPluginEntries() {
	return (getActiveRuntimePluginRegistry()?.speechProviders ?? []).map((entry) => entry.provider);
}
const defaultSpeechProviderRegistry = createSpeechProviderRegistry({
	getProvider: (providerId, cfg) => resolvePluginCapabilityProvider({
		key: "speechProviders",
		providerId,
		cfg
	}),
	listProviders: resolveSpeechProviderPluginEntries
});
const loadedSpeechProviderRegistry = createSpeechProviderRegistry({
	getProvider: (providerId) => resolveLoadedSpeechProviderPluginEntries().find((provider) => {
		if (provider.id === providerId) return true;
		return provider.aliases?.includes(providerId) ?? false;
	}),
	listProviders: () => resolveLoadedSpeechProviderPluginEntries()
});
const listSpeechProviders = defaultSpeechProviderRegistry.listSpeechProviders;
const listLoadedSpeechProviders = loadedSpeechProviderRegistry.listSpeechProviders;
const getSpeechProvider = defaultSpeechProviderRegistry.getSpeechProvider;
const canonicalizeSpeechProviderId = defaultSpeechProviderRegistry.canonicalizeSpeechProviderId;
//#endregion
export { normalizeSpeechProviderId as a, listSpeechProviders as i, getSpeechProvider as n, listLoadedSpeechProviders as r, canonicalizeSpeechProviderId as t };
