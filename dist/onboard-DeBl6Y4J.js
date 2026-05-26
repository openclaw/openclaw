import { n as applyAgentDefaultModelPrimary } from "./provider-onboard-MLXAQX8H.js";
//#region extensions/google/onboard.ts
const GOOGLE_GEMINI_DEFAULT_MODEL = "google/gemini-3.1-pro-preview";
const RETIRED_GOOGLE_GEMINI_MODEL_REFS = new Set([
	"gemini-3-pro",
	"gemini-3-pro-preview",
	"google/gemini-3-pro",
	"google/gemini-3-pro-preview"
]);
function isRetiredGeminiModelRef(value) {
	if (typeof value !== "string") return false;
	const modelRef = value.trim();
	if (RETIRED_GOOGLE_GEMINI_MODEL_REFS.has(modelRef)) return true;
	return modelRef.endsWith("/gemini-3-pro") || modelRef.endsWith("/gemini-3-pro-preview");
}
function hasRetiredGeminiDefaultModelRefs(cfg) {
	const defaults = cfg.agents?.defaults;
	const model = defaults?.model;
	if (model && typeof model === "object") {
		const fallbacks = model.fallbacks;
		if (Array.isArray(fallbacks) && fallbacks.some((fallback) => isRetiredGeminiModelRef(fallback))) return true;
	}
	const models = defaults?.models;
	if (models && typeof models === "object" && Object.keys(models).some((modelRef) => isRetiredGeminiModelRef(modelRef))) return true;
	const providerConfigs = cfg.models?.providers;
	if (!providerConfigs) return false;
	return Object.values(providerConfigs).some((providerConfig) => Array.isArray(providerConfig.models) ? providerConfig.models.some((providerModel) => isRetiredGeminiModelRef(providerModel.id)) : false);
}
function applyGoogleGeminiModelDefault(cfg) {
	const current = cfg.agents?.defaults?.model;
	if ((typeof current === "string" ? current.trim() || void 0 : current && typeof current === "object" && typeof current.primary === "string" ? (current.primary || "").trim() || void 0 : void 0) === "google/gemini-3.1-pro-preview" && !hasRetiredGeminiDefaultModelRefs(cfg)) return {
		next: cfg,
		changed: false
	};
	return {
		next: applyAgentDefaultModelPrimary(cfg, GOOGLE_GEMINI_DEFAULT_MODEL),
		changed: true
	};
}
//#endregion
export { applyGoogleGeminiModelDefault as n, GOOGLE_GEMINI_DEFAULT_MODEL as t };
