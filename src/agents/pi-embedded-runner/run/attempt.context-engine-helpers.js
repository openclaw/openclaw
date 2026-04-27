import { normalizeUsage } from "../../usage.js";
export { assembleHarnessContextEngine as assembleAttemptContextEngine, bootstrapHarnessContextEngine as runAttemptContextEngineBootstrap, finalizeHarnessContextEngineTurn as finalizeAttemptContextEngineTurn, } from "../../harness/context-engine-lifecycle.js";
export async function resolveAttemptBootstrapContext(params) {
    const isContinuationTurn = params.bootstrapMode !== "full" &&
        params.contextInjectionMode === "continuation-skip" &&
        params.bootstrapContextRunKind !== "heartbeat" &&
        (await params.hasCompletedBootstrapTurn(params.sessionFile));
    const shouldSkipBootstrapInjection = params.contextInjectionMode === "never" || isContinuationTurn;
    const shouldRecordCompletedBootstrapTurn = !shouldSkipBootstrapInjection &&
        params.bootstrapContextMode !== "lightweight" &&
        params.bootstrapContextRunKind !== "heartbeat" &&
        params.bootstrapMode === "full";
    const context = shouldSkipBootstrapInjection
        ? { bootstrapFiles: [], contextFiles: [] }
        : await params.resolveBootstrapContextForRun();
    return {
        ...context,
        isContinuationTurn,
        shouldRecordCompletedBootstrapTurn,
    };
}
export function buildContextEnginePromptCacheInfo(params) {
    const promptCache = {};
    if (params.retention) {
        promptCache.retention = params.retention;
    }
    if (params.lastCallUsage) {
        promptCache.lastCallUsage = { ...params.lastCallUsage };
    }
    if (params.observation) {
        promptCache.observation = {
            broke: params.observation.broke,
            ...(typeof params.observation.previousCacheRead === "number"
                ? { previousCacheRead: params.observation.previousCacheRead }
                : {}),
            ...(typeof params.observation.cacheRead === "number"
                ? { cacheRead: params.observation.cacheRead }
                : {}),
            ...(params.observation.changes && params.observation.changes.length > 0
                ? {
                    changes: params.observation.changes.map((change) => ({
                        code: change.code,
                        detail: change.detail,
                    })),
                }
                : {}),
        };
    }
    if (typeof params.lastCacheTouchAt === "number" && Number.isFinite(params.lastCacheTouchAt)) {
        promptCache.lastCacheTouchAt = params.lastCacheTouchAt;
    }
    return Object.keys(promptCache).length > 0 ? promptCache : undefined;
}
export function findCurrentAttemptAssistantMessage(params) {
    return params.messagesSnapshot
        .slice(Math.max(0, params.prePromptMessageCount))
        .toReversed()
        .find((message) => message.role === "assistant");
}
function parsePromptCacheTouchTimestamp(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === "string") {
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    return null;
}
/** Resolve the effective prompt-cache touch timestamp for the current assistant turn. */
export function resolvePromptCacheTouchTimestamp(params) {
    const hasCacheUsage = typeof params.lastCallUsage?.cacheRead === "number" ||
        typeof params.lastCallUsage?.cacheWrite === "number";
    if (!hasCacheUsage) {
        return params.fallbackLastCacheTouchAt ?? null;
    }
    return (parsePromptCacheTouchTimestamp(params.assistantTimestamp) ??
        params.fallbackLastCacheTouchAt ??
        null);
}
export function buildLoopPromptCacheInfo(params) {
    const currentAttemptAssistant = findCurrentAttemptAssistantMessage({
        messagesSnapshot: params.messagesSnapshot,
        prePromptMessageCount: params.prePromptMessageCount,
    });
    const lastCallUsage = normalizeUsage(currentAttemptAssistant?.usage);
    return buildContextEnginePromptCacheInfo({
        retention: params.retention,
        lastCallUsage,
        lastCacheTouchAt: resolvePromptCacheTouchTimestamp({
            lastCallUsage,
            assistantTimestamp: currentAttemptAssistant?.timestamp,
            fallbackLastCacheTouchAt: params.fallbackLastCacheTouchAt,
        }),
    });
}
