import { t as createBaseWebSearchProviderContractFields } from "../../provider-web-search-contract-fields-gQATFxgl.js";
//#region extensions/brave/web-search-contract-api.ts
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function resolveLegacyTopLevelBraveCredential(config) {
	if (!isRecord(config)) return;
	const tools = isRecord(config.tools) ? config.tools : void 0;
	const web = isRecord(tools?.web) ? tools.web : void 0;
	const search = isRecord(web?.search) ? web.search : void 0;
	if (!search || !("apiKey" in search)) return;
	return {
		path: "tools.web.search.apiKey",
		value: search.apiKey
	};
}
function resolveProviderWebSearchPluginConfig(config, pluginId) {
	if (!isRecord(config)) return;
	const plugins = isRecord(config.plugins) ? config.plugins : void 0;
	const entries = isRecord(plugins?.entries) ? plugins.entries : void 0;
	const entry = isRecord(entries?.[pluginId]) ? entries[pluginId] : void 0;
	const pluginConfig = isRecord(entry?.config) ? entry.config : void 0;
	return isRecord(pluginConfig?.webSearch) ? pluginConfig.webSearch : void 0;
}
function resolveConfiguredBraveCredential(config) {
	return resolveProviderWebSearchPluginConfig(config, "brave")?.apiKey ?? resolveLegacyTopLevelBraveCredential(config)?.value;
}
function createBraveWebSearchProvider() {
	const credentialPath = "plugins.entries.brave.config.webSearch.apiKey";
	return {
		id: "brave",
		label: "Brave Search",
		hint: "Structured results · country/language/time filters",
		onboardingScopes: ["text-inference"],
		credentialLabel: "Brave Search API key",
		envVars: ["BRAVE_API_KEY"],
		placeholder: "BSA...",
		signupUrl: "https://brave.com/search/api/",
		docsUrl: "https://docs.openclaw.ai/tools/brave-search",
		autoDetectOrder: 10,
		credentialPath,
		...createBaseWebSearchProviderContractFields({
			credentialPath,
			searchCredential: { type: "top-level" },
			configuredCredential: { pluginId: "brave" }
		}),
		getConfiguredCredentialValue: resolveConfiguredBraveCredential,
		getConfiguredCredentialFallback: resolveLegacyTopLevelBraveCredential,
		createTool: () => null
	};
}
//#endregion
export { createBraveWebSearchProvider };
