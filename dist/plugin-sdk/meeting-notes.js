import { n as resolvePluginCapabilityProvider, r as resolvePluginCapabilityProviders } from "../capability-provider-runtime-BwiWIvn0.js";
import { n as normalizeCapabilityProviderId, t as buildCapabilityProviderMaps } from "../provider-registry-shared-BvRrJpZ_.js";
//#region src/meeting-notes/provider-registry.ts
function normalizeMeetingNotesSourceProviderId(providerId) {
	return normalizeCapabilityProviderId(providerId);
}
function resolveMeetingNotesSourceProviderEntries(cfg) {
	return resolvePluginCapabilityProviders({
		key: "meetingNotesSourceProviders",
		cfg
	});
}
function buildProviderMaps(cfg) {
	return buildCapabilityProviderMaps(resolveMeetingNotesSourceProviderEntries(cfg));
}
function listMeetingNotesSourceProviders(cfg) {
	return [...buildProviderMaps(cfg).canonical.values()];
}
function getMeetingNotesSourceProvider(providerId, cfg) {
	const normalized = normalizeMeetingNotesSourceProviderId(providerId);
	if (!normalized) return;
	const directProvider = resolvePluginCapabilityProvider({
		key: "meetingNotesSourceProviders",
		providerId: normalized,
		cfg
	});
	if (directProvider) return directProvider;
	return buildProviderMaps(cfg).aliases.get(normalized);
}
//#endregion
export { getMeetingNotesSourceProvider, listMeetingNotesSourceProviders, normalizeMeetingNotesSourceProviderId };
