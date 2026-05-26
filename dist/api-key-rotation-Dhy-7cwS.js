import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { n as sleepWithAbort } from "./backoff-BQ4uO4hX.js";
import { a as resolveTransientProviderRetryOptions, i as resolveTransientProviderDelayMs, o as shouldRetrySameKeyProviderOperation, r as resolveTransientProviderAttempts } from "./operation-retry-DSyuuv9E.js";
import { n as isApiKeyRateLimitError, t as collectProviderApiKeys } from "./live-auth-keys-CV0sA4y1.js";
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
	const transientRetry = resolveTransientProviderRetryOptions(params.transientRetry);
	keyLoop: for (let apiKeyIndex = 0; apiKeyIndex < keys.length; apiKeyIndex += 1) {
		const apiKey = keys[apiKeyIndex];
		const maxOperationAttempts = resolveTransientProviderAttempts(transientRetry);
		for (let attemptNumber = 1; attemptNumber <= maxOperationAttempts; attemptNumber += 1) try {
			return await params.execute(apiKey);
		} catch (error) {
			lastError = error;
			const message = formatErrorMessage(error);
			if (params.shouldRetry ? params.shouldRetry({
				apiKey,
				error,
				attempt: apiKeyIndex,
				message
			}) : isApiKeyRateLimitError(message)) {
				if (apiKeyIndex + 1 >= keys.length) break;
				params.onRetry?.({
					apiKey,
					error,
					attempt: apiKeyIndex,
					message
				});
				break;
			}
			if (!transientRetry || !shouldRetrySameKeyProviderOperation({
				options: transientRetry,
				error,
				message,
				provider: params.provider,
				apiKeyIndex,
				attemptNumber,
				maxAttempts: maxOperationAttempts
			})) break keyLoop;
			const delayMs = resolveTransientProviderDelayMs(transientRetry, attemptNumber);
			await (transientRetry.sleep ?? sleepWithAbort)(delayMs, transientRetry.signal);
		}
	}
	if (lastError === void 0) throw new Error(`Failed to run API request for ${params.provider}.`);
	throw lastError;
}
//#endregion
export { executeWithApiKeyRotation as n, collectProviderApiKeysForExecution as t };
