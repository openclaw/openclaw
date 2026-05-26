import { n as OLLAMA_DEFAULT_BASE_URL } from "./defaults-Ct4-oW82.js";
//#region extensions/ollama/provider-policy-api.ts
const OLLAMA_REASONING_THINKING_PROFILE = {
	levels: [
		{ id: "off" },
		{ id: "low" },
		{ id: "medium" },
		{ id: "high" },
		{ id: "max" }
	],
	defaultLevel: "off"
};
const OLLAMA_NON_REASONING_THINKING_PROFILE = {
	levels: [{ id: "off" }],
	defaultLevel: "off"
};
/**
* Provider policy surface for Ollama: normalize provider configs used by
* core defaults/normalizers. This runs during config defaults application and
* normalization paths (not Zod validation).
*/
function normalizeConfig({ provider, providerConfig }) {
	if (!providerConfig || typeof providerConfig !== "object") return providerConfig;
	if ((provider ?? "").trim().toLowerCase() !== "ollama") return providerConfig;
	const next = { ...providerConfig };
	if (typeof next.baseUrl !== "string" || !next.baseUrl.trim()) next.baseUrl = OLLAMA_DEFAULT_BASE_URL;
	if (!Array.isArray(next.models)) next.models = [];
	return next;
}
function resolveThinkingProfile({ reasoning }) {
	return reasoning ? OLLAMA_REASONING_THINKING_PROFILE : OLLAMA_NON_REASONING_THINKING_PROFILE;
}
//#endregion
export { resolveThinkingProfile as n, normalizeConfig as t };
