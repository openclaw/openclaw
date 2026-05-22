import { i as MINIMAX_TEXT_MODEL_ORDER, r as MINIMAX_TEXT_MODEL_CATALOG } from "./provider-models-DHcchnyE.js";
import { g as resolveMinimaxApiCost, i as MINIMAX_API_BASE_URL, n as DEFAULT_MINIMAX_CONTEXT_WINDOW, r as DEFAULT_MINIMAX_MAX_TOKENS } from "./model-definitions-D89tGcBi.js";
//#region extensions/minimax/provider-catalog.ts
function resolveMinimaxCatalogBaseUrl(env = process.env) {
	const rawHost = env.MINIMAX_API_HOST?.trim();
	if (!rawHost) return MINIMAX_API_BASE_URL;
	try {
		const url = new URL(rawHost);
		const basePath = url.pathname.replace(/\/+$/, "");
		if (basePath.endsWith("/anthropic")) return `${url.origin}${basePath}`;
		return `${url.origin}/anthropic`;
	} catch {
		return MINIMAX_API_BASE_URL;
	}
}
function buildMinimaxModel(params) {
	return {
		id: params.id,
		name: params.name,
		reasoning: params.reasoning,
		input: params.input,
		cost: params.cost,
		contextWindow: DEFAULT_MINIMAX_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MINIMAX_MAX_TOKENS
	};
}
function buildMinimaxTextModel(params) {
	return buildMinimaxModel({
		...params,
		input: ["text"]
	});
}
function buildMinimaxCatalog() {
	return MINIMAX_TEXT_MODEL_ORDER.map((id) => {
		const model = MINIMAX_TEXT_MODEL_CATALOG[id];
		return buildMinimaxTextModel({
			id,
			name: model.name,
			reasoning: model.reasoning,
			cost: resolveMinimaxApiCost(id)
		});
	});
}
function buildMinimaxProvider(env) {
	return {
		baseUrl: resolveMinimaxCatalogBaseUrl(env),
		api: "anthropic-messages",
		authHeader: true,
		models: buildMinimaxCatalog()
	};
}
function buildMinimaxPortalProvider(env) {
	return {
		baseUrl: resolveMinimaxCatalogBaseUrl(env),
		api: "anthropic-messages",
		authHeader: true,
		models: buildMinimaxCatalog()
	};
}
//#endregion
export { buildMinimaxProvider as n, buildMinimaxPortalProvider as t };
