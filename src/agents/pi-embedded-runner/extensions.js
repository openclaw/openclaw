import { resolveContextWindowInfo } from "../context-window-guard.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { setCompactionSafeguardRuntime } from "../pi-extensions/compaction-safeguard-runtime.js";
import compactionSafeguardExtension from "../pi-extensions/compaction-safeguard.js";
import contextPruningExtension from "../pi-extensions/context-pruning.js";
import { setContextPruningRuntime } from "../pi-extensions/context-pruning/runtime.js";
import { computeEffectiveSettings } from "../pi-extensions/context-pruning/settings.js";
import { makeToolPrunablePredicate } from "../pi-extensions/context-pruning/tools.js";
import { ensurePiCompactionReserveTokens } from "../pi-settings.js";
import { isCacheTtlEligibleProvider, readLastCacheTtlTimestamp } from "./cache-ttl.js";
function resolveContextWindowTokens(params) {
    return resolveContextWindowInfo({
        cfg: params.cfg,
        provider: params.provider,
        modelId: params.modelId,
        modelContextWindow: params.model?.contextWindow,
        defaultTokens: DEFAULT_CONTEXT_TOKENS,
    }).tokens;
}
function buildContextPruningFactory(params) {
    const raw = params.cfg?.agents?.defaults?.contextPruning;
    if (raw?.mode !== "cache-ttl") {
        return undefined;
    }
    if (!isCacheTtlEligibleProvider(params.provider, params.modelId)) {
        return undefined;
    }
    const settings = computeEffectiveSettings(raw);
    if (!settings) {
        return undefined;
    }
    setContextPruningRuntime(params.sessionManager, {
        settings,
        contextWindowTokens: resolveContextWindowTokens(params),
        isToolPrunable: makeToolPrunablePredicate(settings.tools),
        lastCacheTouchAt: readLastCacheTtlTimestamp(params.sessionManager),
    });
    return contextPruningExtension;
}
function resolveCompactionMode(cfg) {
    return cfg?.agents?.defaults?.compaction?.mode === "safeguard" ? "safeguard" : "default";
}
export function buildEmbeddedExtensionFactories(params) {
    const factories = [];
    if (resolveCompactionMode(params.cfg) === "safeguard") {
        const compactionCfg = params.cfg?.agents?.defaults?.compaction;
        const contextWindowInfo = resolveContextWindowInfo({
            cfg: params.cfg,
            provider: params.provider,
            modelId: params.modelId,
            modelContextWindow: params.model?.contextWindow,
            defaultTokens: DEFAULT_CONTEXT_TOKENS,
        });
        setCompactionSafeguardRuntime(params.sessionManager, {
            maxHistoryShare: compactionCfg?.maxHistoryShare,
            contextWindowTokens: contextWindowInfo.tokens,
            identifierPolicy: compactionCfg?.identifierPolicy,
            identifierInstructions: compactionCfg?.identifierInstructions,
            model: params.model,
        });
        factories.push(compactionSafeguardExtension);
    }
    const pruningFactory = buildContextPruningFactory(params);
    if (pruningFactory) {
        factories.push(pruningFactory);
    }
    return factories;
}
export { ensurePiCompactionReserveTokens };
