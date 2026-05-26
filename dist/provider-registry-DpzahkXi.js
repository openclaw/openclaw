import { n as resolvePluginCapabilityProvider, r as resolvePluginCapabilityProviders } from "./capability-provider-runtime-BwiWIvn0.js";
import { n as normalizeCapabilityProviderId, t as buildCapabilityProviderMaps } from "./provider-registry-shared-BvRrJpZ_.js";
//#region src/realtime-transcription/provider-registry.ts
function normalizeRealtimeTranscriptionProviderId(providerId) {
	return normalizeCapabilityProviderId(providerId);
}
function resolveRealtimeTranscriptionProviderEntries(cfg) {
	return resolvePluginCapabilityProviders({
		key: "realtimeTranscriptionProviders",
		cfg
	});
}
function buildProviderMaps(cfg) {
	return buildCapabilityProviderMaps(resolveRealtimeTranscriptionProviderEntries(cfg));
}
function listRealtimeTranscriptionProviders(cfg) {
	return [...buildProviderMaps(cfg).canonical.values()];
}
function getRealtimeTranscriptionProvider(providerId, cfg) {
	const normalized = normalizeRealtimeTranscriptionProviderId(providerId);
	if (!normalized) return;
	const directProvider = resolvePluginCapabilityProvider({
		key: "realtimeTranscriptionProviders",
		providerId: normalized,
		cfg
	});
	if (directProvider) return directProvider;
	return buildProviderMaps(cfg).aliases.get(normalized);
}
function canonicalizeRealtimeTranscriptionProviderId(providerId, cfg) {
	const normalized = normalizeRealtimeTranscriptionProviderId(providerId);
	if (!normalized) return;
	return getRealtimeTranscriptionProvider(normalized, cfg)?.id ?? normalized;
}
//#endregion
export { normalizeRealtimeTranscriptionProviderId as i, getRealtimeTranscriptionProvider as n, listRealtimeTranscriptionProviders as r, canonicalizeRealtimeTranscriptionProviderId as t };
