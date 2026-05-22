import { s as joinPresentTextSegments } from "./hook-runner-global-j8teApmQ.js";
import { n as resolveProviderEndpoint } from "./provider-attribution-h_knWqVv.js";
import { n as normalizeStructuredPromptSection } from "./prompt-cache-stability-ZHlUg_4F.js";
//#region src/agents/pi-embedded-runner/run/attempt.thread-helpers.ts
const ATTEMPT_CACHE_TTL_CUSTOM_TYPE = "openclaw.cache-ttl";
function composeSystemPromptWithHookContext(params) {
	const prependSystem = typeof params.prependSystemContext === "string" ? normalizeStructuredPromptSection(params.prependSystemContext) : "";
	const appendSystem = typeof params.appendSystemContext === "string" ? normalizeStructuredPromptSection(params.appendSystemContext) : "";
	if (!prependSystem && !appendSystem) return;
	return joinPresentTextSegments([
		prependSystem,
		params.baseSystemPrompt,
		appendSystem
	], { trim: true });
}
function resolveAttemptSpawnWorkspaceDir(params) {
	return params.sandbox?.enabled && params.sandbox.workspaceAccess !== "rw" ? params.resolvedWorkspace : void 0;
}
function shouldUseOpenAIWebSocketTransport(params) {
	if (params.modelApi !== "openai-responses" || params.provider !== "openai") return false;
	const endpointClass = resolveProviderEndpoint(params.modelBaseUrl).endpointClass;
	return endpointClass === "default" || endpointClass === "openai-public";
}
function hasExplicitSseTransport(sources) {
	return sources.some((source) => {
		return (typeof source?.transport === "string" ? source.transport : "").trim().toLowerCase() === "sse";
	});
}
function shouldUseOpenAIWebSocketTransportForAttempt(params) {
	if (hasExplicitSseTransport([
		params.streamParams,
		params.effectiveExtraParams,
		params.modelParams
	])) return false;
	return shouldUseOpenAIWebSocketTransport(params);
}
function shouldAppendAttemptCacheTtl(params) {
	if (params.timedOutDuringCompaction || params.compactionOccurredThisAttempt) return false;
	return params.config?.agents?.defaults?.contextPruning?.mode === "cache-ttl" && params.isCacheTtlEligibleProvider(params.provider, params.modelId, params.modelApi);
}
function appendAttemptCacheTtlIfNeeded(params) {
	if (!shouldAppendAttemptCacheTtl(params)) return false;
	params.sessionManager.appendCustomEntry?.(ATTEMPT_CACHE_TTL_CUSTOM_TYPE, {
		timestamp: params.now ?? Date.now(),
		provider: params.provider,
		modelId: params.modelId
	});
	return true;
}
function shouldPersistCompletedBootstrapTurn(params) {
	if (!params.shouldRecordCompletedBootstrapTurn || params.promptError || params.aborted) return false;
	if (params.timedOutDuringCompaction || params.compactionOccurredThisAttempt) return false;
	return true;
}
//#endregion
export { shouldUseOpenAIWebSocketTransport as a, shouldPersistCompletedBootstrapTurn as i, composeSystemPromptWithHookContext as n, shouldUseOpenAIWebSocketTransportForAttempt as o, resolveAttemptSpawnWorkspaceDir as r, appendAttemptCacheTtlIfNeeded as t };
