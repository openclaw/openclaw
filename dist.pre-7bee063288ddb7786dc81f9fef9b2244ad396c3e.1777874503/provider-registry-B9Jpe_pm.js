import { n as resolvePluginCapabilityProvider, r as resolvePluginCapabilityProviders } from "./capability-provider-runtime-BecgpIaj.js";
import { n as normalizeCapabilityProviderId, t as buildCapabilityProviderMaps } from "./provider-registry-shared-HSm5HKYJ.js";
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
const defaultSpeechProviderRegistry = createSpeechProviderRegistry({
	getProvider: (providerId, cfg) => resolvePluginCapabilityProvider({
		key: "speechProviders",
		providerId,
		cfg
	}),
	listProviders: resolveSpeechProviderPluginEntries
});
const listSpeechProviders = defaultSpeechProviderRegistry.listSpeechProviders;
const getSpeechProvider = defaultSpeechProviderRegistry.getSpeechProvider;
const canonicalizeSpeechProviderId = defaultSpeechProviderRegistry.canonicalizeSpeechProviderId;
//#endregion
export { normalizeSpeechProviderId as i, getSpeechProvider as n, listSpeechProviders as r, canonicalizeSpeechProviderId as t };
