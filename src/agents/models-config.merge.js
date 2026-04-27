import { normalizeOptionalString } from "../shared/string-coerce.js";
import { isNonSecretApiKeyMarker } from "./model-auth-markers.js";
function isPositiveFiniteTokenLimit(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function resolvePreferredTokenLimit(params) {
    if (params.explicitPresent && isPositiveFiniteTokenLimit(params.explicitValue)) {
        return params.explicitValue;
    }
    if (isPositiveFiniteTokenLimit(params.implicitValue)) {
        return params.implicitValue;
    }
    return isPositiveFiniteTokenLimit(params.explicitValue) ? params.explicitValue : undefined;
}
function getProviderModelId(model) {
    if (!model || typeof model !== "object") {
        return "";
    }
    const id = model.id;
    return normalizeOptionalString(id) ?? "";
}
export function mergeProviderModels(implicit, explicit) {
    const implicitModels = Array.isArray(implicit.models) ? implicit.models : [];
    const explicitModels = Array.isArray(explicit.models) ? explicit.models : [];
    const implicitHeaders = implicit.headers && typeof implicit.headers === "object" && !Array.isArray(implicit.headers)
        ? implicit.headers
        : undefined;
    const explicitHeaders = explicit.headers && typeof explicit.headers === "object" && !Array.isArray(explicit.headers)
        ? explicit.headers
        : undefined;
    if (implicitModels.length === 0) {
        return {
            ...implicit,
            ...explicit,
            ...(implicitHeaders || explicitHeaders
                ? {
                    headers: {
                        ...implicitHeaders,
                        ...explicitHeaders,
                    },
                }
                : {}),
        };
    }
    const implicitById = new Map(implicitModels
        .map((model) => [getProviderModelId(model), model])
        .filter(([id]) => Boolean(id)));
    const seen = new Set();
    const mergedModels = explicitModels.map((explicitModel) => {
        const id = getProviderModelId(explicitModel);
        if (!id) {
            return explicitModel;
        }
        seen.add(id);
        const implicitModel = implicitById.get(id);
        if (!implicitModel) {
            return explicitModel;
        }
        const contextWindow = resolvePreferredTokenLimit({
            explicitPresent: "contextWindow" in explicitModel,
            explicitValue: explicitModel.contextWindow,
            implicitValue: implicitModel.contextWindow,
        });
        const contextTokens = resolvePreferredTokenLimit({
            explicitPresent: "contextTokens" in explicitModel,
            explicitValue: explicitModel.contextTokens,
            implicitValue: implicitModel.contextTokens,
        });
        const maxTokens = resolvePreferredTokenLimit({
            explicitPresent: "maxTokens" in explicitModel,
            explicitValue: explicitModel.maxTokens,
            implicitValue: implicitModel.maxTokens,
        });
        return Object.assign({}, explicitModel, {
            input: implicitModel.input,
            reasoning: `reasoning` in explicitModel ? explicitModel.reasoning : implicitModel.reasoning,
        }, contextWindow === undefined ? {} : { contextWindow }, contextTokens === undefined ? {} : { contextTokens }, maxTokens === undefined ? {} : { maxTokens });
    });
    for (const implicitModel of implicitModels) {
        const id = getProviderModelId(implicitModel);
        if (!id || seen.has(id)) {
            continue;
        }
        seen.add(id);
        mergedModels.push(implicitModel);
    }
    return {
        ...implicit,
        ...explicit,
        ...(implicitHeaders || explicitHeaders
            ? {
                headers: {
                    ...implicitHeaders,
                    ...explicitHeaders,
                },
            }
            : {}),
        models: mergedModels,
    };
}
export function mergeProviders(params) {
    const out = params.implicit ? { ...params.implicit } : {};
    for (const [key, explicit] of Object.entries(params.explicit ?? {})) {
        const providerKey = normalizeOptionalString(key) ?? "";
        if (!providerKey) {
            continue;
        }
        const implicit = out[providerKey];
        out[providerKey] = implicit ? mergeProviderModels(implicit, explicit) : explicit;
    }
    return out;
}
function resolveProviderApi(entry) {
    return normalizeOptionalString(entry?.api);
}
function resolveModelApiSurface(entry) {
    if (!Array.isArray(entry?.models)) {
        return undefined;
    }
    const apis = entry.models
        .flatMap((model) => {
        if (!model || typeof model !== "object") {
            return [];
        }
        const api = model.api;
        const normalized = normalizeOptionalString(api);
        return normalized ? [normalized] : [];
    })
        .toSorted();
    return apis.length > 0 ? JSON.stringify(apis) : undefined;
}
function resolveProviderApiSurface(entry) {
    return resolveProviderApi(entry) ?? resolveModelApiSurface(entry);
}
function shouldPreserveExistingApiKey(params) {
    const { providerKey, existing, nextEntry, secretRefManagedProviders } = params;
    const nextApiKey = typeof nextEntry.apiKey === "string" ? nextEntry.apiKey : "";
    if (nextApiKey && isNonSecretApiKeyMarker(nextApiKey)) {
        return false;
    }
    return (!secretRefManagedProviders.has(providerKey) &&
        typeof existing.apiKey === "string" &&
        existing.apiKey.length > 0 &&
        !isNonSecretApiKeyMarker(existing.apiKey, { includeEnvVarName: false }));
}
function shouldPreserveExistingBaseUrl(params) {
    const { existing, nextEntry } = params;
    if (typeof existing.baseUrl !== "string" || existing.baseUrl.length === 0) {
        return false;
    }
    const existingApi = resolveProviderApiSurface(existing);
    const nextApi = resolveProviderApiSurface(nextEntry);
    return !existingApi || !nextApi || existingApi === nextApi;
}
export function mergeWithExistingProviderSecrets(params) {
    const { nextProviders, existingProviders, secretRefManagedProviders } = params;
    const mergedProviders = {};
    for (const [key, entry] of Object.entries(existingProviders)) {
        mergedProviders[key] = entry;
    }
    for (const [key, newEntry] of Object.entries(nextProviders)) {
        const existing = existingProviders[key];
        if (!existing) {
            mergedProviders[key] = newEntry;
            continue;
        }
        const preserved = {};
        if (shouldPreserveExistingApiKey({
            providerKey: key,
            existing,
            nextEntry: newEntry,
            secretRefManagedProviders,
        })) {
            preserved.apiKey = existing.apiKey;
        }
        if (shouldPreserveExistingBaseUrl({
            existing,
            nextEntry: newEntry,
        })) {
            preserved.baseUrl = existing.baseUrl;
        }
        mergedProviders[key] = { ...newEntry, ...preserved };
    }
    return mergedProviders;
}
