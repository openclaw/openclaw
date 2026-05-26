import { s as normalizePluginsConfig } from "./config-state-CjJBf8PG.js";
import { t as loadBundledPluginPublicArtifactModuleSync } from "./public-surface-loader-B6ofplrA.js";
import { i as passesManifestOwnerBasePolicy } from "./manifest-owner-policy-DqV-lgQl.js";
import { i as registerHealthCheck } from "./health-check-registry-DxXQHCTW.js";
//#region src/flows/bundled-health-checks.ts
function registerBundledHealthChecks(params) {
	if (!shouldRegisterPolicyHealth(params)) return;
	loadBundledPluginPublicArtifactModuleSync({
		dirName: "policy",
		artifactBasename: "api.js"
	}).registerPolicyDoctorChecks?.({ registerHealthCheck });
}
function shouldRegisterPolicyHealth(params) {
	const entry = params.cfg.plugins?.entries?.policy;
	const config = isRecord(entry?.config) ? entry.config : {};
	if (entry === void 0 || entry.enabled === false || config.enabled === false) return false;
	if (!passesManifestOwnerBasePolicy({
		plugin: { id: "policy" },
		normalizedConfig: normalizePluginsConfig(params.cfg.plugins)
	})) return false;
	return entry.enabled === true || config.enabled === true;
}
function isRecord(value) {
	return typeof value === "object" && value !== null;
}
//#endregion
export { registerBundledHealthChecks as t };
