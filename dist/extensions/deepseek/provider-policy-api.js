import { n as DEEPSEEK_MODEL_CATALOG } from "../../models-CMCEiKpv.js";
import { t as resolveDeepSeekV4ThinkingProfile } from "../../thinking-DpufZF19.js";
//#region extensions/deepseek/provider-policy-api.ts
/**
* Build a lookup from the bundled DeepSeek model catalog so we can hydrate
* missing metadata (contextWindow, cost, maxTokens) into user-configured
* model rows without overwriting explicit overrides.
*/
function buildCatalogIndex() {
	const index = /* @__PURE__ */ new Map();
	for (const model of DEEPSEEK_MODEL_CATALOG) index.set(model.id, model);
	return index;
}
function isPositiveNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function hasCostValues(cost) {
	if (!cost || typeof cost !== "object") return false;
	const c = cost;
	return typeof c.input === "number" || typeof c.output === "number" || typeof c.cacheRead === "number" || typeof c.cacheWrite === "number";
}
/**
* Provider policy surface for DeepSeek.
*
* Hydrates missing `contextWindow`, `cost`, and `maxTokens` from the bundled
* catalog for matching model ids. Explicit user overrides are preserved.
*/
function normalizeConfig(params) {
	const { providerConfig } = params;
	if (!Array.isArray(providerConfig.models) || providerConfig.models.length === 0) return providerConfig;
	const catalog = buildCatalogIndex();
	let mutated = false;
	const nextModels = providerConfig.models.map((model) => {
		const raw = model;
		const catalogEntry = catalog.get(raw.id);
		if (!catalogEntry) return model;
		let modelMutated = false;
		const patched = {};
		if (!isPositiveNumber(raw.contextWindow) && isPositiveNumber(catalogEntry.contextWindow)) {
			patched.contextWindow = catalogEntry.contextWindow;
			modelMutated = true;
		}
		if (!isPositiveNumber(raw.maxTokens) && isPositiveNumber(catalogEntry.maxTokens)) {
			patched.maxTokens = catalogEntry.maxTokens;
			modelMutated = true;
		}
		if (!hasCostValues(raw.cost) && hasCostValues(catalogEntry.cost)) {
			patched.cost = catalogEntry.cost;
			modelMutated = true;
		}
		if (!modelMutated) return model;
		mutated = true;
		return {
			...raw,
			...patched
		};
	});
	if (!mutated) return providerConfig;
	return {
		...providerConfig,
		models: nextModels
	};
}
function resolveThinkingProfile(params) {
	return params.provider.trim().toLowerCase() === "deepseek" ? resolveDeepSeekV4ThinkingProfile(params.modelId) : null;
}
//#endregion
export { normalizeConfig, resolveThinkingProfile };
