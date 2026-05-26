import { r as normalizeProviderId } from "./provider-id-Cz7K6wgK.js";
import { m as loadPluginRegistrySnapshotWithMetadata } from "./plugin-registry-Cdr1zbpf.js";
import { r as getPluginRegistryState } from "./runtime-state-Br1Hd8D7.js";
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
function resolveManifestSyntheticAuthProviderRefs() {
	const result = loadPluginRegistrySnapshotWithMetadata({});
	if (result.source !== "persisted" && result.source !== "provided") return [];
	return uniqueProviderRefs(result.snapshot.plugins.flatMap((plugin) => plugin.syntheticAuthRefs ?? []));
}
function resolveRuntimeSyntheticAuthProviderRefs() {
	const registry = getPluginRegistryState()?.activeRegistry;
	if (registry) return uniqueProviderRefs([...(registry.providers ?? []).filter((entry) => "resolveSyntheticAuth" in entry.provider && typeof entry.provider.resolveSyntheticAuth === "function").map((entry) => entry.provider.id), ...(registry.cliBackends ?? []).filter((entry) => "resolveSyntheticAuth" in entry.backend && typeof entry.backend.resolveSyntheticAuth === "function").map((entry) => entry.backend.id)]);
	return resolveManifestSyntheticAuthProviderRefs();
}
//#endregion
export { resolveRuntimeSyntheticAuthProviderRefs as t };
