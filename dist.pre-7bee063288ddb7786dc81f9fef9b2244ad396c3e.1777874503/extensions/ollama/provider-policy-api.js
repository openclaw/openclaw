import { n as OLLAMA_DEFAULT_BASE_URL } from "../../defaults-B1sRy6bb.js";
//#region extensions/ollama/provider-policy-api.ts
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
//#endregion
export { normalizeConfig };
