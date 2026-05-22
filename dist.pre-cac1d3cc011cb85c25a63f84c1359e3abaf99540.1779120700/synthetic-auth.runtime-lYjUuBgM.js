import { r as normalizeProviderId } from "./provider-id-Cz7K6wgK.js";
import { t as loadPluginManifestRegistryForInstalledIndex } from "./manifest-registry-installed-DnW6OVaz.js";
import { m as loadPluginRegistrySnapshotWithMetadata } from "./plugin-registry-B_Amd26i.js";
import { r as getPluginRegistryState } from "./runtime-state-DE_1Nc0_.js";
//#region src/plugins/synthetic-auth.runtime.ts
function uniqueProviderRefs(values) {
	const seen = /* @__PURE__ */ new Set();
	const next = [];
	for (const raw of values) {
		const trimmed = raw.trim();
		const normalized = normalizeProviderId(trimmed);
		if (!trimmed || seen.has(normalized)) continue;
		seen.add(normalized);
		next.push(trimmed);
	}
	return next;
}
function resolveManifestSyntheticAuthProviderRefs(params = {}) {
	if (params.index && (params.registryDiagnostics?.length ?? 0) > 0) return [];
	const result = loadPluginRegistrySnapshotWithMetadata({ index: params.index });
	if (result.source !== "persisted" && result.source !== "provided") return [];
	return uniqueProviderRefs(result.snapshot.plugins.flatMap((plugin) => plugin.syntheticAuthRefs ?? []));
}
function resolveManifestExternalAuthProviderRefs(params = {}) {
	if (params.index && (params.registryDiagnostics?.length ?? 0) > 0) return [];
	const result = loadPluginRegistrySnapshotWithMetadata({ index: params.index });
	if (result.source !== "persisted" && result.source !== "provided") return [];
	return uniqueProviderRefs(loadPluginManifestRegistryForInstalledIndex({ index: result.snapshot }).plugins.flatMap((plugin) => plugin.contracts?.externalAuthProviders ?? []));
}
function resolveRuntimeSyntheticAuthProviderRefs(params = {}) {
	const registry = getPluginRegistryState()?.activeRegistry;
	if (registry) return uniqueProviderRefs([...(registry.providers ?? []).filter((entry) => "resolveSyntheticAuth" in entry.provider && typeof entry.provider.resolveSyntheticAuth === "function").map((entry) => entry.provider.id), ...(registry.cliBackends ?? []).filter((entry) => "resolveSyntheticAuth" in entry.backend && typeof entry.backend.resolveSyntheticAuth === "function").map((entry) => entry.backend.id)]);
	return resolveManifestSyntheticAuthProviderRefs({
		index: params.index,
		registryDiagnostics: params.registryDiagnostics
	});
}
function resolveRuntimeExternalAuthProviderRefs(params = {}) {
	const registry = getPluginRegistryState()?.activeRegistry;
	if (registry) return uniqueProviderRefs([
		...registry.plugins.flatMap((plugin) => plugin.contracts?.externalAuthProviders ?? []),
		...(registry.providers ?? []).filter((entry) => "resolveExternalAuthProfiles" in entry.provider && typeof entry.provider.resolveExternalAuthProfiles === "function" || "resolveExternalOAuthProfiles" in entry.provider && typeof entry.provider.resolveExternalOAuthProfiles === "function").map((entry) => entry.provider.id),
		...(registry.cliBackends ?? []).filter((entry) => "resolveExternalAuthProfiles" in entry.backend && typeof entry.backend.resolveExternalAuthProfiles === "function" || "resolveExternalOAuthProfiles" in entry.backend && typeof entry.backend.resolveExternalOAuthProfiles === "function").map((entry) => entry.backend.id)
	]);
	return resolveManifestExternalAuthProviderRefs({
		index: params.index,
		registryDiagnostics: params.registryDiagnostics
	});
}
//#endregion
export { resolveRuntimeSyntheticAuthProviderRefs as n, resolveRuntimeExternalAuthProviderRefs as t };
