import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { t as loadPluginManifestRegistryForInstalledIndex } from "./manifest-registry-installed-HgZGS-Bx.js";
import { m as loadPluginRegistrySnapshotWithMetadata } from "./plugin-registry-CgH_ZSlH.js";
import { r as getPluginRegistryState } from "./runtime-state-DRIYGASz.js";
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
function resolveManifestSyntheticAuthProviderRefState(params = {}) {
	if (params.index && (params.registryDiagnostics?.length ?? 0) > 0) return {
		refs: [],
		complete: false
	};
	const result = loadPluginRegistrySnapshotWithMetadata(params);
	if (result.source !== "persisted" && result.source !== "provided") return {
		refs: [],
		complete: false
	};
	return {
		refs: uniqueProviderRefs(result.snapshot.plugins.flatMap((plugin) => plugin.syntheticAuthRefs ?? [])),
		complete: true
	};
}
function resolveManifestExternalAuthProviderRefs(params = {}) {
	if (params.index && (params.registryDiagnostics?.length ?? 0) > 0) return [];
	const result = loadPluginRegistrySnapshotWithMetadata(params);
	if (result.source !== "persisted" && result.source !== "provided") return [];
	return uniqueProviderRefs(loadPluginManifestRegistryForInstalledIndex({ index: result.snapshot }).plugins.flatMap((plugin) => plugin.contracts?.externalAuthProviders ?? []));
}
function resolveRuntimeSyntheticAuthProviderRefs(params = {}) {
	return resolveRuntimeSyntheticAuthProviderRefState(params).refs;
}
function resolveRuntimeSyntheticAuthProviderRefState(params = {}) {
	const registry = getPluginRegistryState()?.activeRegistry;
	if (registry) return {
		refs: uniqueProviderRefs([
			...registry.plugins.flatMap((plugin) => plugin.syntheticAuthRefs ?? []),
			...(registry.providers ?? []).filter((entry) => "resolveSyntheticAuth" in entry.provider && typeof entry.provider.resolveSyntheticAuth === "function").map((entry) => entry.provider.id),
			...(registry.cliBackends ?? []).filter((entry) => "resolveSyntheticAuth" in entry.backend && typeof entry.backend.resolveSyntheticAuth === "function").map((entry) => entry.backend.id)
		]),
		complete: true
	};
	return resolveManifestSyntheticAuthProviderRefState(params);
}
function resolveRuntimeExternalAuthProviderRefs(params = {}) {
	const registry = getPluginRegistryState()?.activeRegistry;
	if (registry) return uniqueProviderRefs([
		...registry.plugins.flatMap((plugin) => plugin.contracts?.externalAuthProviders ?? []),
		...(registry.providers ?? []).filter((entry) => "resolveExternalAuthProfiles" in entry.provider && typeof entry.provider.resolveExternalAuthProfiles === "function" || "resolveExternalOAuthProfiles" in entry.provider && typeof entry.provider.resolveExternalOAuthProfiles === "function").map((entry) => entry.provider.id),
		...(registry.cliBackends ?? []).filter((entry) => "resolveExternalAuthProfiles" in entry.backend && typeof entry.backend.resolveExternalAuthProfiles === "function" || "resolveExternalOAuthProfiles" in entry.backend && typeof entry.backend.resolveExternalOAuthProfiles === "function").map((entry) => entry.backend.id)
	]);
	return resolveManifestExternalAuthProviderRefs(params);
}
//#endregion
export { resolveRuntimeSyntheticAuthProviderRefState as n, resolveRuntimeSyntheticAuthProviderRefs as r, resolveRuntimeExternalAuthProviderRefs as t };
