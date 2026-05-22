import { i as FALLBACK_CODEX_MODELS, o as buildCodexProviderConfig, r as CODEX_PROVIDER_ID, t as CODEX_APP_SERVER_AUTH_MARKER } from "./provider-catalog-bEFBkMDi.js";
//#region extensions/codex/provider-discovery.ts
function resolveCodexPluginConfig(ctx) {
	return (ctx.config.plugins?.entries)?.codex?.config;
}
async function runCodexCatalog(ctx) {
	const { buildCodexProviderCatalog } = await import("./provider.js");
	return await buildCodexProviderCatalog({
		env: ctx.env,
		pluginConfig: resolveCodexPluginConfig(ctx)
	});
}
const codexProviderDiscovery = {
	id: CODEX_PROVIDER_ID,
	label: "Codex",
	docsPath: "/providers/models",
	auth: [],
	catalog: {
		order: "late",
		run: runCodexCatalog
	},
	staticCatalog: {
		order: "late",
		run: async () => ({ provider: buildCodexProviderConfig(FALLBACK_CODEX_MODELS) })
	},
	resolveSyntheticAuth: () => ({
		apiKey: CODEX_APP_SERVER_AUTH_MARKER,
		source: "codex-app-server",
		mode: "token"
	})
};
//#endregion
export { codexProviderDiscovery, codexProviderDiscovery as default };
