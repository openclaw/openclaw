import { i as buildOllamaProvider } from "../../provider-base-url-CrecHiog.js";
import { i as shouldUseSyntheticOllamaAuth, n as OLLAMA_PROVIDER_ID, r as resolveOllamaDiscoveryResult, t as OLLAMA_DEFAULT_API_KEY } from "../../discovery-shared-ROvQIBGQ.js";
//#region extensions/ollama/provider-discovery.ts
function resolveOllamaPluginConfig(ctx) {
	return (ctx.config.plugins?.entries ?? {}).ollama?.config ?? {};
}
async function runOllamaDiscovery(ctx) {
	return await resolveOllamaDiscoveryResult({
		ctx,
		pluginConfig: resolveOllamaPluginConfig(ctx),
		buildProvider: buildOllamaProvider
	});
}
const ollamaProviderDiscovery = {
	id: OLLAMA_PROVIDER_ID,
	label: "Ollama",
	docsPath: "/providers/ollama",
	envVars: ["OLLAMA_API_KEY"],
	auth: [],
	resolveSyntheticAuth: ({ provider, providerConfig }) => {
		if (!shouldUseSyntheticOllamaAuth(providerConfig)) return;
		return {
			apiKey: OLLAMA_DEFAULT_API_KEY,
			source: `models.providers.${provider ?? "ollama"} (synthetic local key)`,
			mode: "api-key"
		};
	},
	catalog: {
		order: "late",
		run: runOllamaDiscovery
	}
};
//#endregion
export { ollamaProviderDiscovery as default, ollamaProviderDiscovery };
