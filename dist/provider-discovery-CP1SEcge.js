import { t as createLazyImportLoader } from "./lazy-promise-Djskx0qC.js";
import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import "./model-selection-P-81eBKx.js";
import "./manifest-contribution-ids-tozuTTjv.js";
//#region src/plugins/provider-discovery.ts
const DISCOVERY_ORDER = [
	"simple",
	"profile",
	"paired",
	"late"
];
const DANGEROUS_PROVIDER_KEYS = new Set([
	"__proto__",
	"prototype",
	"constructor"
]);
const providerRuntimeLoader = createLazyImportLoader(() => import("./plugins/provider-discovery.runtime.js"));
function loadProviderRuntime() {
	return providerRuntimeLoader.load();
}
function resolveProviderCatalogHook(provider) {
	return provider.catalog ?? provider.discovery;
}
function resolveProviderCatalogOrderHook(provider) {
	return resolveProviderCatalogHook(provider) ?? provider.staticCatalog;
}
function createProviderConfigRecord() {
	return Object.create(null);
}
function isSafeProviderConfigKey(value) {
	return value !== "" && !DANGEROUS_PROVIDER_KEYS.has(value);
}
async function resolveRuntimePluginDiscoveryProviders(params) {
	return (await loadProviderRuntime()).resolvePluginDiscoveryProvidersRuntime(params).filter((provider) => resolveProviderCatalogOrderHook(provider));
}
function groupPluginDiscoveryProvidersByOrder(providers) {
	const grouped = {
		simple: [],
		profile: [],
		paired: [],
		late: []
	};
	for (const provider of providers) grouped[resolveProviderCatalogOrderHook(provider)?.order ?? "late"].push(provider);
	for (const order of DISCOVERY_ORDER) grouped[order].sort((a, b) => a.label.localeCompare(b.label));
	return grouped;
}
function normalizePluginDiscoveryResult(params) {
	const result = params.result;
	if (!result) return {};
	if ("provider" in result) {
		const normalized = createProviderConfigRecord();
		for (const providerId of [
			params.provider.id,
			...params.provider.aliases ?? [],
			...params.provider.hookAliases ?? []
		]) {
			const normalizedKey = normalizeProviderId(providerId);
			if (!isSafeProviderConfigKey(normalizedKey)) continue;
			normalized[normalizedKey] = result.provider;
		}
		return normalized;
	}
	const normalized = createProviderConfigRecord();
	for (const [key, value] of Object.entries(result.providers)) {
		const normalizedKey = normalizeProviderId(key);
		if (!isSafeProviderConfigKey(normalizedKey) || !value) continue;
		normalized[normalizedKey] = value;
	}
	return normalized;
}
function runProviderCatalog(params) {
	return resolveProviderCatalogHook(params.provider)?.run({
		config: params.config,
		agentDir: params.agentDir,
		workspaceDir: params.workspaceDir,
		env: params.env,
		resolveProviderApiKey: params.resolveProviderApiKey,
		resolveProviderAuth: params.resolveProviderAuth
	});
}
function runProviderStaticCatalog(params) {
	return params.provider.staticCatalog?.run({
		config: {},
		env: {},
		resolveProviderApiKey: () => ({ apiKey: void 0 }),
		resolveProviderAuth: () => ({
			apiKey: void 0,
			mode: "none",
			source: "none"
		})
	});
}
//#endregion
export { runProviderStaticCatalog as a, runProviderCatalog as i, normalizePluginDiscoveryResult as n, resolveRuntimePluginDiscoveryProviders as r, groupPluginDiscoveryProvidersByOrder as t };
