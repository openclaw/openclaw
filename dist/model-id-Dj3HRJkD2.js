//#region extensions/google/model-id.ts
const ANTIGRAVITY_BARE_PRO_IDS = new Set([
	"gemini-3-pro",
	"gemini-3.1-pro",
	"gemini-3-1-pro"
]);
const GOOGLE_PROVIDER_PREFIX = "google/";
function normalizeGoogleModelId(id) {
	if (id.startsWith(GOOGLE_PROVIDER_PREFIX)) {
		const modelId = id.slice(7);
		const normalizedModelId = normalizeGoogleModelId(modelId);
		return normalizedModelId === modelId ? id : `${GOOGLE_PROVIDER_PREFIX}${normalizedModelId}`;
	}
	if (id === "gemini-3-pro" || id === "gemini-3-pro-preview") return "gemini-3.1-pro-preview";
	if (id === "gemini-3-flash") return "gemini-3-flash-preview";
	if (id === "gemini-3.1-pro") return "gemini-3.1-pro-preview";
	if (id === "gemini-3.1-flash-lite") return "gemini-3.1-flash-lite-preview";
	if (id === "gemini-3.1-flash" || id === "gemini-3.1-flash-preview") return "gemini-3-flash-preview";
	return id;
}
function normalizeAntigravityModelId(id) {
	if (ANTIGRAVITY_BARE_PRO_IDS.has(id)) return `${id}-low`;
	return id;
}
//#endregion
export { normalizeGoogleModelId as n, normalizeAntigravityModelId as t };
