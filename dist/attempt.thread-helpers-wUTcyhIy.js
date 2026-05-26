import { c as joinPresentTextSegments } from "./hook-runner-global-BkXXy1ub.js";
import { n as normalizeStructuredPromptSection } from "./prompt-cache-stability-B_6GljRB.js";
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
export { shouldPersistCompletedBootstrapTurn as i, composeSystemPromptWithHookContext as n, resolveAttemptSpawnWorkspaceDir as r, appendAttemptCacheTtlIfNeeded as t };
