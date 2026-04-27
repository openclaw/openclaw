import { readStringValue } from "../shared/string-coerce.js";
import { resolveProviderRequestCapabilities } from "./provider-attribution.js";
const optionalString = readStringValue;
export function resolvesToNativeOpenAIStrictTools(model, transport) {
    const capabilities = resolveProviderRequestCapabilities({
        provider: optionalString(model.provider),
        api: optionalString(model.api),
        baseUrl: optionalString(model.baseUrl),
        capability: "llm",
        transport,
        modelId: optionalString(model.id),
        compat: model.compat,
    });
    if (!capabilities.usesKnownNativeOpenAIRoute) {
        return false;
    }
    return (capabilities.provider === "openai" ||
        capabilities.provider === "openai-codex" ||
        capabilities.provider === "azure-openai" ||
        capabilities.provider === "azure-openai-responses");
}
export function resolveOpenAIStrictToolSetting(model, options) {
    if (resolvesToNativeOpenAIStrictTools(model, options?.transport ?? "stream")) {
        return true;
    }
    if (options?.supportsStrictMode) {
        return false;
    }
    return undefined;
}
