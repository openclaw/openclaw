import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-Bje8XVt9.js";
//#region src/agents/provider-id.ts
function normalizeProviderId(provider) {
	const normalized = normalizeLowercaseStringOrEmpty(provider);
	if (normalized === "modelstudio" || normalized === "qwencloud") return "qwen";
	if (normalized === "z.ai" || normalized === "z-ai") return "zai";
	if (normalized === "opencode-zen") return "opencode";
	if (normalized === "opencode-go-auth") return "opencode-go";
	if (normalized === "kimi" || normalized === "kimi-code" || normalized === "kimi-coding") return "kimi";
	if (normalized === "bedrock" || normalized === "aws-bedrock") return "amazon-bedrock";
	if (normalized === "bytedance" || normalized === "doubao") return "volcengine";
	return normalized;
}
/** Normalize provider ID before manifest-owned auth alias lookup. */
function normalizeProviderIdForAuth(provider) {
	return normalizeProviderId(provider);
}
function findNormalizedProviderValue(entries, provider) {
	if (!entries) return;
	const providerKey = normalizeProviderId(provider);
	for (const [key, value] of Object.entries(entries)) if (normalizeProviderId(key) === providerKey) return value;
}
function findNormalizedProviderKey(entries, provider) {
	if (!entries) return;
	const providerKey = normalizeProviderId(provider);
	return Object.keys(entries).find((key) => normalizeProviderId(key) === providerKey);
}
//#endregion
export { normalizeProviderIdForAuth as i, findNormalizedProviderValue as n, normalizeProviderId as r, findNormalizedProviderKey as t };
