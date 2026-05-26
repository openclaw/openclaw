import { i as formatErrorMessage } from "./errors-VfATXfah.js";
import { n as isApiKeyRateLimitError, t as collectProviderApiKeys } from "./live-auth-keys-2P2pJAt3.js";
//#region src/agents/api-key-rotation.ts
function dedupeApiKeys(raw) {
	const seen = /* @__PURE__ */ new Set();
	const keys = [];
	for (const value of raw) {
		const apiKey = value.trim();
		if (!apiKey || seen.has(apiKey)) continue;
		seen.add(apiKey);
		keys.push(apiKey);
	}
	return keys;
}
function collectProviderApiKeysForExecution(params) {
	const { primaryApiKey, provider } = params;
	return dedupeApiKeys([primaryApiKey?.trim() ?? "", ...collectProviderApiKeys(provider)]);
}
async function executeWithApiKeyRotation(params) {
	const keys = dedupeApiKeys(params.apiKeys);
	if (keys.length === 0) throw new Error(`No API keys configured for provider "${params.provider}".`);
	let lastError;
	for (let attempt = 0; attempt < keys.length; attempt += 1) {
		const apiKey = keys[attempt];
		try {
			return await params.execute(apiKey);
		} catch (error) {
			lastError = error;
			const message = formatErrorMessage(error);
			if (!(params.shouldRetry ? params.shouldRetry({
				apiKey,
				error,
				attempt,
				message
			}) : isApiKeyRateLimitError(message)) || attempt + 1 >= keys.length) break;
			params.onRetry?.({
				apiKey,
				error,
				attempt,
				message
			});
		}
	}
	if (lastError === void 0) throw new Error(`Failed to run API request for ${params.provider}.`);
	throw lastError;
}
//#endregion
export { executeWithApiKeyRotation as n, collectProviderApiKeysForExecution as t };
