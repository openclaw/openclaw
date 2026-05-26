import { l as resolveEffectivePluginActivationState } from "./config-state-CjJBf8PG.js";
import { t as isPluginEnabledByDefaultForPlatform } from "./default-enablement-CT7_t1ee.js";
//#region src/plugins/manifest-owner-policy.ts
function isBundledManifestOwner(plugin) {
	return plugin.origin === "bundled";
}
function hasExplicitManifestOwnerTrust(params) {
	return params.normalizedConfig.allow.includes(params.plugin.id) || params.normalizedConfig.entries[params.plugin.id]?.enabled === true;
}
function passesManifestOwnerBasePolicy(params) {
	return resolveManifestOwnerBasePolicyBlock(params) === null;
}
function resolveManifestOwnerBasePolicyBlock(params) {
	if (!params.normalizedConfig.enabled) return "plugins-disabled";
	if (params.normalizedConfig.deny.includes(params.plugin.id)) return "blocked-by-denylist";
	if (params.normalizedConfig.entries[params.plugin.id]?.enabled === false && params.allowExplicitlyDisabled !== true) return "plugin-disabled";
	if (params.allowRestrictiveAllowlistBypass !== true && params.normalizedConfig.allow.length > 0 && !params.normalizedConfig.allow.includes(params.plugin.id)) return "not-in-allowlist";
	return null;
}
function isActivatedManifestOwner(params) {
	return resolveEffectivePluginActivationState({
		id: params.plugin.id,
		origin: params.plugin.origin,
		config: params.normalizedConfig,
		rootConfig: params.rootConfig,
		enabledByDefault: isPluginEnabledByDefaultForPlatform(params.plugin)
	}).activated;
}
//#endregion
export { resolveManifestOwnerBasePolicyBlock as a, passesManifestOwnerBasePolicy as i, isActivatedManifestOwner as n, isBundledManifestOwner as r, hasExplicitManifestOwnerTrust as t };
