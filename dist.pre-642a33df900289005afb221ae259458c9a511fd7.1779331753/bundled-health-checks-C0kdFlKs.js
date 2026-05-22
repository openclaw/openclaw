import { s as normalizePluginsConfig } from "./config-state-Davgc29h.js";
import { t as loadBundledPluginPublicArtifactModuleSync } from "./public-surface-loader-CxDi8L7Q.js";
import { i as passesManifestOwnerBasePolicy } from "./manifest-owner-policy-D9A5yXj7.js";
import { r as registerHealthCheck } from "./health-check-registry-C91n923I.js";
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
