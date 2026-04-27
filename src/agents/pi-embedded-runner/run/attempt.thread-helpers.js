import { joinPresentTextSegments } from "../../../shared/text/join-segments.js";
import { normalizeStructuredPromptSection } from "../../prompt-cache-stability.js";
import { resolveProviderEndpoint } from "../../provider-attribution.js";
export const ATTEMPT_CACHE_TTL_CUSTOM_TYPE = "openclaw.cache-ttl";
export function composeSystemPromptWithHookContext(params) {
    const prependSystem = typeof params.prependSystemContext === "string"
        ? normalizeStructuredPromptSection(params.prependSystemContext)
        : "";
    const appendSystem = typeof params.appendSystemContext === "string"
        ? normalizeStructuredPromptSection(params.appendSystemContext)
        : "";
    if (!prependSystem && !appendSystem) {
        return undefined;
    }
    return joinPresentTextSegments([prependSystem, params.baseSystemPrompt, appendSystem], {
        trim: true,
    });
}
export function resolveAttemptSpawnWorkspaceDir(params) {
    return params.sandbox?.enabled && params.sandbox.workspaceAccess !== "rw"
        ? params.resolvedWorkspace
        : undefined;
}
export function shouldUseOpenAIWebSocketTransport(params) {
    if (params.modelApi !== "openai-responses" || params.provider !== "openai") {
        return false;
    }
    // openai-codex normalizes to the ChatGPT backend HTTP path, not the public
    // OpenAI Responses websocket endpoint. Local mocks, proxies, and custom
    // baseUrls must stay on HTTP because the websocket runtime targets the
    // native api.openai.com endpoint directly.
    const endpointClass = resolveProviderEndpoint(params.modelBaseUrl).endpointClass;
    return endpointClass === "default" || endpointClass === "openai-public";
}
export function shouldAppendAttemptCacheTtl(params) {
    if (params.timedOutDuringCompaction || params.compactionOccurredThisAttempt) {
        return false;
    }
    return (params.config?.agents?.defaults?.contextPruning?.mode === "cache-ttl" &&
        params.isCacheTtlEligibleProvider(params.provider, params.modelId, params.modelApi));
}
export function appendAttemptCacheTtlIfNeeded(params) {
    if (!shouldAppendAttemptCacheTtl(params)) {
        return false;
    }
    params.sessionManager.appendCustomEntry?.(ATTEMPT_CACHE_TTL_CUSTOM_TYPE, {
        timestamp: params.now ?? Date.now(),
        provider: params.provider,
        modelId: params.modelId,
    });
    return true;
}
export function shouldPersistCompletedBootstrapTurn(params) {
    if (!params.shouldRecordCompletedBootstrapTurn || params.promptError || params.aborted) {
        return false;
    }
    if (params.timedOutDuringCompaction || params.compactionOccurredThisAttempt) {
        return false;
    }
    return true;
}
