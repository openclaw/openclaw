import { MODEL_APIS } from "../config/types.models.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
const GENERIC_PROVIDER_APIS = new Set([
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
    "google-generative-ai",
]);
export function resolveProviderPluginLookupKey(providerKey, provider) {
    const api = normalizeOptionalString(provider?.api) ?? "";
    if (providerKey === "google-antigravity" ||
        providerKey === "google-vertex" ||
        api === "google-generative-ai") {
        return "google";
    }
    if (provider?.models?.some((model) => normalizeOptionalString(model.api) === "google-generative-ai")) {
        return "google";
    }
    if (api &&
        MODEL_APIS.includes(api) &&
        !GENERIC_PROVIDER_APIS.has(api)) {
        return api;
    }
    return providerKey;
}
