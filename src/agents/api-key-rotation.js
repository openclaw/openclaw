import { formatErrorMessage } from "../infra/errors.js";
import { collectProviderApiKeys, isApiKeyRateLimitError } from "./live-auth-keys.js";
function dedupeApiKeys(raw) {
    const seen = new Set();
    const keys = [];
    for (const value of raw) {
        const apiKey = value.trim();
        if (!apiKey || seen.has(apiKey)) {
            continue;
        }
        seen.add(apiKey);
        keys.push(apiKey);
    }
    return keys;
}
export function collectProviderApiKeysForExecution(params) {
    const { primaryApiKey, provider } = params;
    return dedupeApiKeys([primaryApiKey?.trim() ?? "", ...collectProviderApiKeys(provider)]);
}
export async function executeWithApiKeyRotation(params) {
    const keys = dedupeApiKeys(params.apiKeys);
    if (keys.length === 0) {
        throw new Error(`No API keys configured for provider "${params.provider}".`);
    }
    let lastError;
    for (let attempt = 0; attempt < keys.length; attempt += 1) {
        const apiKey = keys[attempt];
        try {
            return await params.execute(apiKey);
        }
        catch (error) {
            lastError = error;
            const message = formatErrorMessage(error);
            const retryable = params.shouldRetry
                ? params.shouldRetry({ apiKey, error, attempt, message })
                : isApiKeyRateLimitError(message);
            if (!retryable || attempt + 1 >= keys.length) {
                break;
            }
            params.onRetry?.({ apiKey, error, attempt, message });
        }
    }
    if (lastError === undefined) {
        throw new Error(`Failed to run API request for ${params.provider}.`);
    }
    throw lastError;
}
