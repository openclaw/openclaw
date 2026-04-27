import crypto from "node:crypto";
import { parseGeminiAuth } from "../../infra/gemini-auth.js";
import { normalizeGoogleApiBaseUrl } from "../../infra/google-api-base-url.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { buildGuardedModelFetch } from "../provider-transport-fetch.js";
import { stableStringify } from "../stable-stringify.js";
import { stripSystemPromptCacheBoundary } from "../system-prompt-cache-boundary.js";
import { mergeTransportHeaders, sanitizeTransportPayloadText } from "../transport-stream-shared.js";
import { log } from "./logger.js";
import { isGooglePromptCacheEligible, resolveCacheRetention } from "./prompt-cache-retention.js";
import { streamWithPayloadPatch } from "./stream-payload-utils.js";
const GOOGLE_PROMPT_CACHE_CUSTOM_TYPE = "openclaw.google-prompt-cache";
const GOOGLE_PROMPT_CACHE_RETRY_BACKOFF_MS = 10 * 60_000;
const GOOGLE_PROMPT_CACHE_SHORT_REFRESH_WINDOW_MS = 30_000;
const GOOGLE_PROMPT_CACHE_LONG_REFRESH_WINDOW_MS = 5 * 60_000;
function resolveGooglePromptCacheTtl(cacheRetention) {
    return cacheRetention === "long" ? "3600s" : "300s";
}
function resolveGooglePromptCacheRefreshWindowMs(cacheRetention) {
    return cacheRetention === "long"
        ? GOOGLE_PROMPT_CACHE_LONG_REFRESH_WINDOW_MS
        : GOOGLE_PROMPT_CACHE_SHORT_REFRESH_WINDOW_MS;
}
function digestSystemPrompt(systemPrompt) {
    return crypto.createHash("sha256").update(systemPrompt).digest("hex");
}
function resolveManagedSystemPrompt(systemPrompt) {
    const stripped = typeof systemPrompt === "string" ? stripSystemPromptCacheBoundary(systemPrompt) : "";
    const sanitized = sanitizeTransportPayloadText(stripped);
    return sanitized.trim() ? sanitized : undefined;
}
function resolveExplicitCachedContent(extraParams) {
    const raw = typeof extraParams?.cachedContent === "string"
        ? extraParams.cachedContent
        : typeof extraParams?.cached_content === "string"
            ? extraParams.cached_content
            : undefined;
    const trimmed = raw?.trim();
    return trimmed ? trimmed : undefined;
}
function buildGooglePromptCacheMatchKey(params) {
    return stableStringify(params);
}
function stringifyGooglePromptCacheKeyPart(value) {
    if (typeof value === "string") {
        return value;
    }
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
        return String(value);
    }
    return "";
}
function readLatestGooglePromptCacheEntry(sessionManager, matchKey) {
    try {
        const entries = sessionManager.getEntries();
        for (let i = entries.length - 1; i >= 0; i -= 1) {
            const entry = entries[i];
            if (entry?.type !== "custom" || entry?.customType !== GOOGLE_PROMPT_CACHE_CUSTOM_TYPE) {
                continue;
            }
            const data = entry.data;
            if (!data || typeof data !== "object") {
                continue;
            }
            const cacheData = data;
            const candidateKey = buildGooglePromptCacheMatchKey({
                provider: stringifyGooglePromptCacheKeyPart(cacheData.provider),
                modelId: stringifyGooglePromptCacheKeyPart(cacheData.modelId),
                modelApi: typeof cacheData.modelApi === "string" || cacheData.modelApi == null
                    ? cacheData.modelApi
                    : null,
                baseUrl: stringifyGooglePromptCacheKeyPart(cacheData.baseUrl),
                systemPromptDigest: stringifyGooglePromptCacheKeyPart(cacheData.systemPromptDigest),
            });
            if (candidateKey === matchKey) {
                return data;
            }
        }
    }
    catch {
        return null;
    }
    return null;
}
function appendGooglePromptCacheEntry(sessionManager, entry) {
    try {
        sessionManager.appendCustomEntry(GOOGLE_PROMPT_CACHE_CUSTOM_TYPE, entry);
    }
    catch {
        // ignore persistence failures
    }
}
function parseExpireTimeMs(expireTime) {
    if (!expireTime) {
        return null;
    }
    const timestamp = Date.parse(expireTime);
    return Number.isFinite(timestamp) ? timestamp : null;
}
function buildManagedContextWithoutSystemPrompt(context) {
    if (!context.systemPrompt) {
        return context;
    }
    return {
        ...context,
        systemPrompt: undefined,
    };
}
async function updateGooglePromptCacheTtl(params) {
    const response = await params.fetchImpl(`${params.baseUrl}/${params.cachedContent}?updateMask=ttl`, {
        method: "PATCH",
        headers: mergeTransportHeaders(parseGeminiAuth(params.apiKey).headers, params.headers),
        body: JSON.stringify({
            ttl: resolveGooglePromptCacheTtl(params.cacheRetention),
        }),
        signal: params.signal,
    });
    if (!response.ok) {
        return null;
    }
    const json = (await response.json());
    return json;
}
async function createGooglePromptCache(params) {
    const response = await params.fetchImpl(`${params.baseUrl}/cachedContents`, {
        method: "POST",
        headers: mergeTransportHeaders(parseGeminiAuth(params.apiKey).headers, params.headers),
        body: JSON.stringify({
            model: params.modelId.startsWith("models/") ? params.modelId : `models/${params.modelId}`,
            ttl: resolveGooglePromptCacheTtl(params.cacheRetention),
            systemInstruction: {
                parts: [{ text: params.systemPrompt }],
            },
        }),
        signal: params.signal,
    });
    if (!response.ok) {
        return null;
    }
    const json = (await response.json());
    const cachedContent = normalizeOptionalString(json.name) ?? "";
    return cachedContent ? { cachedContent, expireTime: json.expireTime } : null;
}
async function ensureGooglePromptCache(params, deps) {
    const baseUrl = normalizeGoogleApiBaseUrl(params.model.baseUrl);
    const now = deps.now?.() ?? Date.now();
    const systemPromptDigest = digestSystemPrompt(params.systemPrompt);
    const matchKey = buildGooglePromptCacheMatchKey({
        provider: params.provider,
        modelId: params.model.id,
        modelApi: params.model.api,
        baseUrl,
        systemPromptDigest,
    });
    const latestEntry = readLatestGooglePromptCacheEntry(params.sessionManager, matchKey);
    if (latestEntry?.status === "failed" && latestEntry.retryAfter > now) {
        return null;
    }
    const fetchImpl = (deps.buildGuardedFetch ?? buildGuardedModelFetch)(params.model);
    const refreshWindowMs = resolveGooglePromptCacheRefreshWindowMs(params.cacheRetention);
    if (latestEntry?.status === "ready" && latestEntry.cachedContent) {
        const expiresAt = parseExpireTimeMs(latestEntry.expireTime);
        const isExpired = expiresAt !== null && expiresAt <= now;
        if (!isExpired) {
            const needsRefresh = expiresAt !== null && expiresAt - now <= refreshWindowMs;
            if (!needsRefresh) {
                return latestEntry.cachedContent;
            }
            const refreshed = await updateGooglePromptCacheTtl({
                apiKey: params.apiKey,
                baseUrl,
                cacheRetention: params.cacheRetention,
                cachedContent: latestEntry.cachedContent,
                fetchImpl,
                headers: params.model.headers,
                signal: params.signal,
            }).catch(() => null);
            if (refreshed) {
                appendGooglePromptCacheEntry(params.sessionManager, {
                    status: "ready",
                    timestamp: now,
                    provider: params.provider,
                    modelId: params.model.id,
                    modelApi: params.model.api,
                    baseUrl,
                    systemPromptDigest,
                    cacheRetention: params.cacheRetention,
                    cachedContent: latestEntry.cachedContent,
                    expireTime: refreshed.expireTime ?? latestEntry.expireTime,
                });
                return latestEntry.cachedContent;
            }
            return latestEntry.cachedContent;
        }
    }
    const created = await createGooglePromptCache({
        apiKey: params.apiKey,
        baseUrl,
        cacheRetention: params.cacheRetention,
        fetchImpl,
        headers: params.model.headers,
        modelId: params.model.id,
        signal: params.signal,
        systemPrompt: params.systemPrompt,
    });
    if (!created) {
        appendGooglePromptCacheEntry(params.sessionManager, {
            status: "failed",
            timestamp: now,
            provider: params.provider,
            modelId: params.model.id,
            modelApi: params.model.api,
            baseUrl,
            systemPromptDigest,
            cacheRetention: params.cacheRetention,
            retryAfter: now + GOOGLE_PROMPT_CACHE_RETRY_BACKOFF_MS,
        });
        return null;
    }
    appendGooglePromptCacheEntry(params.sessionManager, {
        status: "ready",
        timestamp: now,
        provider: params.provider,
        modelId: params.model.id,
        modelApi: params.model.api,
        baseUrl,
        systemPromptDigest,
        cacheRetention: params.cacheRetention,
        cachedContent: created.cachedContent,
        expireTime: created.expireTime,
    });
    return created.cachedContent;
}
export async function prepareGooglePromptCacheStreamFn(params, deps = {}) {
    if (!params.streamFn) {
        return undefined;
    }
    if (resolveExplicitCachedContent(params.extraParams)) {
        return undefined;
    }
    if (!isGooglePromptCacheEligible({ modelApi: params.model.api, modelId: params.modelId })) {
        return undefined;
    }
    const resolvedRetention = resolveCacheRetention(params.extraParams, params.provider, params.model.api, params.modelId);
    if (resolvedRetention !== "short" && resolvedRetention !== "long") {
        return undefined;
    }
    const systemPrompt = resolveManagedSystemPrompt(params.systemPrompt);
    const apiKey = params.apiKey?.trim();
    if (!systemPrompt || !apiKey) {
        return undefined;
    }
    const cachedContent = await ensureGooglePromptCache({
        apiKey,
        cacheRetention: resolvedRetention,
        model: params.model,
        provider: params.provider,
        sessionManager: params.sessionManager,
        signal: params.signal,
        systemPrompt,
    }, deps);
    if (!cachedContent) {
        log.debug(`google prompt cache unavailable for ${params.provider}/${params.modelId}; continuing without cachedContent`);
        return undefined;
    }
    const inner = params.streamFn;
    return (model, context, options) => streamWithPayloadPatch(inner, model, buildManagedContextWithoutSystemPrompt(context), options, (payload) => {
        payload.cachedContent = cachedContent;
    });
}
