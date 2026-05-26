import { c as isRecord } from "./utils-sBTEdeml.js";
import { a as listOfficialExternalPluginCatalogEntries, c as resolveOfficialExternalPluginInstall, l as resolveOfficialExternalPluginLabel, r as getOfficialExternalPluginCatalogManifest } from "./official-external-plugin-catalog-f6g4JsA2.js";
import { t as enablePluginInConfig } from "./enable-DL58ncJE.js";
//#region src/plugins/web-search-install-catalog.ts
function normalizeString(value) {
	return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function normalizeStringList(value) {
	return Array.isArray(value) ? value.map(normalizeString).filter((entry) => Boolean(entry)) : [];
}
function normalizeOnboardingScopes(value) {
	if (!Array.isArray(value)) return;
	const scopes = value.filter((entry) => entry === "text-inference");
	return scopes.length > 0 ? scopes : void 0;
}
function pathSegments(path) {
	return path.split(".").map((segment) => segment.trim()).filter((segment) => segment.length > 0);
}
function getConfigPath(config, path) {
	let current = config;
	for (const segment of pathSegments(path)) {
		if (!isRecord(current)) return;
		current = current[segment];
	}
	return current;
}
function setConfigPath(target, path, value) {
	const segments = pathSegments(path);
	let current = target;
	for (const segment of segments.slice(0, -1)) {
		const next = current[segment];
		if (!isRecord(next)) current[segment] = {};
		current = current[segment];
	}
	const leaf = segments.at(-1);
	if (leaf) current[leaf] = value;
}
function buildProviderEntry(params) {
	const providerId = normalizeString(params.provider.id);
	const label = normalizeString(params.provider.label);
	const hint = normalizeString(params.provider.hint);
	const credentialPath = normalizeString(params.provider.credentialPath) ?? `plugins.entries.${params.pluginId}.config.webSearch.apiKey`;
	const envVars = normalizeStringList(params.provider.envVars);
	const placeholder = normalizeString(params.provider.placeholder);
	const signupUrl = normalizeString(params.provider.signupUrl);
	if (!providerId || !label || !hint || envVars.length === 0 || !placeholder || !signupUrl) return null;
	return {
		id: providerId,
		pluginId: params.pluginId,
		label,
		hint,
		envVars,
		placeholder,
		signupUrl,
		credentialPath,
		...normalizeOnboardingScopes(params.provider.onboardingScopes) ? { onboardingScopes: normalizeOnboardingScopes(params.provider.onboardingScopes) } : {},
		...params.provider.requiresCredential === false ? { requiresCredential: false } : {},
		...normalizeString(params.provider.credentialLabel) ? { credentialLabel: normalizeString(params.provider.credentialLabel) } : {},
		...normalizeString(params.provider.docsUrl) ? { docsUrl: normalizeString(params.provider.docsUrl) } : {},
		...typeof params.provider.autoDetectOrder === "number" ? { autoDetectOrder: params.provider.autoDetectOrder } : {},
		getCredentialValue: (searchConfig) => searchConfig?.apiKey,
		setCredentialValue: (searchConfigTarget, value) => {
			searchConfigTarget.apiKey = value;
		},
		getConfiguredCredentialValue: (config) => getConfigPath(config, credentialPath),
		setConfiguredCredentialValue: (configTarget, value) => {
			setConfigPath(configTarget, credentialPath, value);
		},
		applySelectionConfig: (config) => enablePluginInConfig(config, params.pluginId).config,
		createTool: () => null
	};
}
function resolveWebSearchInstallCatalogEntries() {
	const entries = [];
	for (const entry of listOfficialExternalPluginCatalogEntries()) {
		const manifest = getOfficialExternalPluginCatalogManifest(entry);
		const pluginId = normalizeString(manifest?.plugin?.id);
		const install = resolveOfficialExternalPluginInstall(entry);
		if (!manifest || !pluginId || !install) continue;
		for (const provider of manifest.webSearchProviders ?? []) {
			const providerEntry = buildProviderEntry({
				pluginId,
				provider
			});
			if (!providerEntry) continue;
			entries.push({
				pluginId,
				label: resolveOfficialExternalPluginLabel(entry),
				install,
				provider: providerEntry,
				trustedSourceLinkedOfficialInstall: true
			});
		}
	}
	return entries.toSorted((left, right) => left.provider.label.localeCompare(right.provider.label) || left.provider.id.localeCompare(right.provider.id));
}
function resolveWebSearchInstallCatalogEntry(params) {
	const providerId = normalizeString(params.providerId);
	const pluginId = normalizeString(params.pluginId);
	return resolveWebSearchInstallCatalogEntries().find((entry) => (!providerId || entry.provider.id === providerId) && (!pluginId || entry.pluginId === pluginId));
}
//#endregion
export { resolveWebSearchInstallCatalogEntry as n, resolveWebSearchInstallCatalogEntries as t };
