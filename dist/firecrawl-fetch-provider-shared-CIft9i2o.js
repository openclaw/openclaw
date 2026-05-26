//#region extensions/firecrawl/src/firecrawl-fetch-provider-shared.ts
function ensureRecord(target, key) {
	const current = target[key];
	if (current && typeof current === "object" && !Array.isArray(current)) return current;
	const next = {};
	target[key] = next;
	return next;
}
const FIRECRAWL_WEB_FETCH_PROVIDER_SHARED = {
	id: "firecrawl",
	label: "Firecrawl",
	hint: "Fetch pages with Firecrawl for JS-heavy or bot-protected sites.",
	envVars: ["FIRECRAWL_API_KEY"],
	placeholder: "fc-...",
	signupUrl: "https://www.firecrawl.dev/",
	docsUrl: "https://docs.firecrawl.dev",
	autoDetectOrder: 50,
	credentialPath: "plugins.entries.firecrawl.config.webFetch.apiKey",
	inactiveSecretPaths: ["plugins.entries.firecrawl.config.webFetch.apiKey", "tools.web.fetch.firecrawl.apiKey"],
	getCredentialValue: (fetchConfig) => {
		if (!fetchConfig || typeof fetchConfig !== "object") return;
		const legacy = fetchConfig.firecrawl;
		if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)) return;
		if (legacy.enabled === false) return;
		return legacy.apiKey;
	},
	setCredentialValue: (fetchConfigTarget, value) => {
		const firecrawl = ensureRecord(fetchConfigTarget, "firecrawl");
		firecrawl.apiKey = value;
	},
	getConfiguredCredentialValue: (config) => (config?.plugins?.entries?.firecrawl?.config)?.webFetch?.apiKey,
	setConfiguredCredentialValue: (configTarget, value) => {
		const webFetch = ensureRecord(ensureRecord(ensureRecord(ensureRecord(ensureRecord(configTarget, "plugins"), "entries"), "firecrawl"), "config"), "webFetch");
		webFetch.apiKey = value;
	}
};
//#endregion
export { FIRECRAWL_WEB_FETCH_PROVIDER_SHARED as t };
