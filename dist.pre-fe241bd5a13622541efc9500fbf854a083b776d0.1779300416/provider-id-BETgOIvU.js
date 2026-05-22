import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
//#region src/media-understanding/provider-id.ts
function normalizeMediaProviderId(id) {
	const normalized = normalizeProviderId(id);
	if (normalized === "gemini") return "google";
	if (normalized === "minimax-cn") return "minimax";
	if (normalized === "minimax-portal-cn") return "minimax-portal";
	return normalized;
}
function normalizeMediaExecutionProviderId(id) {
	const normalized = normalizeProviderId(id);
	if (normalized === "minimax-cn" || normalized === "minimax-portal-cn") return normalized;
	return normalizeMediaProviderId(normalized);
}
//#endregion
export { normalizeMediaProviderId as n, normalizeMediaExecutionProviderId as t };
