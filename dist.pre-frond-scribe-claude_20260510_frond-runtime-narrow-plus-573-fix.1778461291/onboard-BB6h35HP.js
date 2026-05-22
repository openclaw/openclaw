import { n as applyAgentDefaultModelPrimary } from "./provider-onboard-BUyG9wYK.js";
//#region extensions/google/onboard.ts
const GOOGLE_GEMINI_DEFAULT_MODEL = "google/gemini-2.5-flash";
function applyGoogleGeminiModelDefault(cfg) {
	const current = cfg.agents?.defaults?.model;
	if ((typeof current === "string" ? current.trim() || void 0 : current && typeof current === "object" && typeof current.primary === "string" ? (current.primary || "").trim() || void 0 : void 0) === "google/gemini-2.5-flash") return {
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
