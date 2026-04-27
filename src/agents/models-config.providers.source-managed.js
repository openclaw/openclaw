import { resolveSecretInputRef } from "../config/types.secrets.js";
import { isRecord } from "../utils.js";
import { resolveNonEnvSecretRefApiKeyMarker, resolveNonEnvSecretRefHeaderValueMarker, resolveEnvSecretRefHeaderValueMarker, } from "./model-auth-markers.js";
function normalizeSourceProviderLookup(providers) {
    if (!providers) {
        return {};
    }
    const out = {};
    for (const [key, provider] of Object.entries(providers)) {
        const normalizedKey = key.trim();
        if (!normalizedKey || !isRecord(provider)) {
            continue;
        }
        out[normalizedKey] = provider;
    }
    return out;
}
function resolveSourceManagedApiKeyMarker(params) {
    const sourceApiKeyRef = resolveSecretInputRef({
        value: params.sourceProvider?.apiKey,
        defaults: params.sourceSecretDefaults,
    }).ref;
    if (!sourceApiKeyRef || !sourceApiKeyRef.id.trim()) {
        return undefined;
    }
    return sourceApiKeyRef.source === "env"
        ? sourceApiKeyRef.id.trim()
        : resolveNonEnvSecretRefApiKeyMarker(sourceApiKeyRef.source);
}
function resolveSourceManagedHeaderMarkers(params) {
    const sourceHeaders = isRecord(params.sourceProvider?.headers)
        ? params.sourceProvider.headers
        : undefined;
    if (!sourceHeaders) {
        return {};
    }
    const markers = {};
    for (const [headerName, headerValue] of Object.entries(sourceHeaders)) {
        const sourceHeaderRef = resolveSecretInputRef({
            value: headerValue,
            defaults: params.sourceSecretDefaults,
        }).ref;
        if (!sourceHeaderRef || !sourceHeaderRef.id.trim()) {
            continue;
        }
        markers[headerName] =
            sourceHeaderRef.source === "env"
                ? resolveEnvSecretRefHeaderValueMarker(sourceHeaderRef.id)
                : resolveNonEnvSecretRefHeaderValueMarker(sourceHeaderRef.source);
    }
    return markers;
}
export function enforceSourceManagedProviderSecrets(params) {
    const { providers } = params;
    if (!providers) {
        return providers;
    }
    const sourceProvidersByKey = normalizeSourceProviderLookup(params.sourceProviders);
    if (Object.keys(sourceProvidersByKey).length === 0) {
        return providers;
    }
    let nextProviders = null;
    for (const [providerKey, provider] of Object.entries(providers)) {
        if (!isRecord(provider)) {
            continue;
        }
        const sourceProvider = sourceProvidersByKey[providerKey.trim()];
        if (!sourceProvider) {
            continue;
        }
        let nextProvider = provider;
        let providerMutated = false;
        const sourceApiKeyMarker = resolveSourceManagedApiKeyMarker({
            sourceProvider,
            sourceSecretDefaults: params.sourceSecretDefaults,
        });
        if (sourceApiKeyMarker) {
            params.secretRefManagedProviders?.add(providerKey.trim());
            if (nextProvider.apiKey !== sourceApiKeyMarker) {
                providerMutated = true;
                nextProvider = {
                    ...nextProvider,
                    apiKey: sourceApiKeyMarker,
                };
            }
        }
        const sourceHeaderMarkers = resolveSourceManagedHeaderMarkers({
            sourceProvider,
            sourceSecretDefaults: params.sourceSecretDefaults,
        });
        if (Object.keys(sourceHeaderMarkers).length > 0) {
            const currentHeaders = isRecord(nextProvider.headers)
                ? nextProvider.headers
                : undefined;
            const nextHeaders = {
                ...currentHeaders,
            };
            let headersMutated = !currentHeaders;
            for (const [headerName, marker] of Object.entries(sourceHeaderMarkers)) {
                if (nextHeaders[headerName] === marker) {
                    continue;
                }
                headersMutated = true;
                nextHeaders[headerName] = marker;
            }
            if (headersMutated) {
                providerMutated = true;
                nextProvider = {
                    ...nextProvider,
                    headers: nextHeaders,
                };
            }
        }
        if (!providerMutated) {
            continue;
        }
        if (!nextProviders) {
            nextProviders = { ...providers };
        }
        nextProviders[providerKey] = nextProvider;
    }
    return nextProviders ?? providers;
}
