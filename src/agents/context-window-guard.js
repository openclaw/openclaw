import { resolveProviderEndpoint } from "./provider-attribution.js";
import { findNormalizedProviderValue } from "./provider-id.js";
export const CONTEXT_WINDOW_HARD_MIN_TOKENS = 16_000;
export const CONTEXT_WINDOW_WARN_BELOW_TOKENS = 32_000;
function normalizePositiveInt(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return null;
    }
    const int = Math.floor(value);
    return int > 0 ? int : null;
}
export function resolveContextWindowInfo(params) {
    const fromModelsConfig = (() => {
        const providers = params.cfg?.models?.providers;
        const providerEntry = findNormalizedProviderValue(providers, params.provider);
        const models = Array.isArray(providerEntry?.models) ? providerEntry.models : [];
        const match = models.find((m) => m?.id === params.modelId);
        return normalizePositiveInt(match?.contextTokens) ?? normalizePositiveInt(match?.contextWindow);
    })();
    const fromModel = normalizePositiveInt(params.modelContextTokens) ??
        normalizePositiveInt(params.modelContextWindow);
    const baseInfo = fromModelsConfig
        ? { tokens: fromModelsConfig, source: "modelsConfig" }
        : fromModel
            ? { tokens: fromModel, source: "model" }
            : { tokens: Math.floor(params.defaultTokens), source: "default" };
    const capTokens = normalizePositiveInt(params.cfg?.agents?.defaults?.contextTokens);
    if (capTokens && capTokens < baseInfo.tokens) {
        return { tokens: capTokens, source: "agentContextTokens" };
    }
    return baseInfo;
}
export function resolveContextWindowGuardHint(params) {
    const endpoint = resolveProviderEndpoint(params.runtimeBaseUrl ?? undefined);
    return {
        endpointClass: endpoint.endpointClass,
        likelySelfHosted: endpoint.endpointClass === "local",
    };
}
export function formatContextWindowWarningMessage(params) {
    const base = `low context window: ${params.provider}/${params.modelId} ctx=${params.guard.tokens} (warn<${CONTEXT_WINDOW_WARN_BELOW_TOKENS}) source=${params.guard.source}`;
    const hint = resolveContextWindowGuardHint({ runtimeBaseUrl: params.runtimeBaseUrl });
    if (!hint.likelySelfHosted) {
        return base;
    }
    if (params.guard.source === "agentContextTokens") {
        return (`${base}; OpenClaw is capped by agents.defaults.contextTokens, so raise that cap ` +
            `if you want to use more of the model context window`);
    }
    if (params.guard.source === "modelsConfig") {
        return (`${base}; OpenClaw is using the configured model context limit for this model, ` +
            `so raise contextWindow/contextTokens if it is set too low`);
    }
    return (`${base}; local/self-hosted runs work best at ` +
        `${CONTEXT_WINDOW_WARN_BELOW_TOKENS}+ tokens and may show weaker tool use or more compaction until the server/model context limit is raised`);
}
export function formatContextWindowBlockMessage(params) {
    const base = `Model context window too small (${params.guard.tokens} tokens; ` +
        `source=${params.guard.source}). Minimum is ${CONTEXT_WINDOW_HARD_MIN_TOKENS}.`;
    const hint = resolveContextWindowGuardHint({ runtimeBaseUrl: params.runtimeBaseUrl });
    if (!hint.likelySelfHosted) {
        return base;
    }
    if (params.guard.source === "agentContextTokens") {
        return `${base} OpenClaw is capped by agents.defaults.contextTokens. Raise that cap.`;
    }
    if (params.guard.source === "modelsConfig") {
        return (`${base} OpenClaw is using the configured model context limit for this model. ` +
            `Raise contextWindow/contextTokens or choose a larger model.`);
    }
    return (`${base} This looks like a local model endpoint. ` +
        `Raise the server/model context limit or choose a larger model. ` +
        `OpenClaw local/self-hosted runs work best at ${CONTEXT_WINDOW_WARN_BELOW_TOKENS}+ tokens.`);
}
export function evaluateContextWindowGuard(params) {
    const warnBelow = Math.max(1, Math.floor(params.warnBelowTokens ?? CONTEXT_WINDOW_WARN_BELOW_TOKENS));
    const hardMin = Math.max(1, Math.floor(params.hardMinTokens ?? CONTEXT_WINDOW_HARD_MIN_TOKENS));
    const tokens = Math.max(0, Math.floor(params.info.tokens));
    return {
        ...params.info,
        tokens,
        shouldWarn: tokens > 0 && tokens < warnBelow,
        shouldBlock: tokens > 0 && tokens < hardMin,
    };
}
