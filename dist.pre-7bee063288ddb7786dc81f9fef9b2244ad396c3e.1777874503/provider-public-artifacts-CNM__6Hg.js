import { n as resolveBundledPluginsDir } from "./bundled-dir-m7NsR8Gx.js";
import { t as loadBundledPluginPublicArtifactModuleSync } from "./public-surface-loader-KP09XqO0.js";
import { t as loadPluginManifestRegistry } from "./manifest-registry-C9Iavh95.js";
import { r as normalizeProviderId } from "./provider-id-dd60CFPS.js";
//#region src/plugins/provider-public-artifacts.ts
const PROVIDER_POLICY_ARTIFACT_CANDIDATES = ["provider-policy-api.js"];
function hasProviderPolicyHook(mod) {
	return typeof mod.normalizeConfig === "function" || typeof mod.applyConfigDefaults === "function" || typeof mod.resolveConfigApiKey === "function" || typeof mod.resolveThinkingProfile === "function";
}
function tryLoadBundledProviderPolicySurface(pluginId) {
	for (const artifactBasename of PROVIDER_POLICY_ARTIFACT_CANDIDATES) try {
		const mod = loadBundledPluginPublicArtifactModuleSync({
			dirName: pluginId,
			artifactBasename
		});
		if (hasProviderPolicyHook(mod)) return mod;
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("Unable to resolve bundled plugin public surface ")) continue;
		throw error;
	}
	return null;
}
function resolveBundledProviderPolicyPluginId(providerId) {
	const normalizedProviderId = normalizeProviderId(providerId);
	if (!normalizedProviderId) return null;
	if (!resolveBundledPluginsDir()) return null;
	const registry = loadPluginManifestRegistry();
	for (const plugin of registry.plugins.toSorted((left, right) => left.id.localeCompare(right.id))) {
		if (plugin.origin !== "bundled") continue;
		if (plugin.providers.some((provider) => normalizeProviderId(provider) === normalizedProviderId)) return plugin.id;
	}
	return null;
}
function resolveBundledProviderPolicySurface(providerId) {
	const normalizedProviderId = normalizeProviderId(providerId);
	if (!normalizedProviderId) return null;
	return tryLoadBundledProviderPolicySurface(normalizedProviderId) ?? tryLoadBundledProviderPolicySurface(resolveBundledProviderPolicyPluginId(normalizedProviderId) ?? normalizedProviderId);
}
//#endregion
export { resolveBundledProviderPolicySurface as t };
