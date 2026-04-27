import { resolveAgentModelFallbackValues } from "../config/model-input.js";
import { buildAllowedModelSetWithFallbacks, buildModelAliasIndex, getModelRefStatusWithFallbackModels, resolveAllowedModelRefFromAliasIndex, } from "./model-selection-shared.js";
export { buildConfiguredAllowlistKeys, buildConfiguredModelCatalog, buildModelAliasIndex, inferUniqueProviderFromConfiguredModels, normalizeModelSelection, resolveConfiguredModelRef, resolveHooksGmailModel, resolveModelRefFromString, } from "./model-selection-shared.js";
function resolveDefaultFallbackModels(cfg) {
    return resolveAgentModelFallbackValues(cfg.agents?.defaults?.model);
}
export function buildAllowedModelSet(params) {
    const { cfg, catalog, defaultProvider, defaultModel } = params;
    return buildAllowedModelSetWithFallbacks({
        cfg,
        catalog,
        defaultProvider,
        defaultModel,
        fallbackModels: resolveDefaultFallbackModels(cfg),
    });
}
export function getModelRefStatus(params) {
    const { cfg, catalog, ref, defaultProvider, defaultModel } = params;
    return getModelRefStatusWithFallbackModels({
        cfg,
        catalog,
        ref,
        defaultProvider,
        defaultModel,
        fallbackModels: resolveDefaultFallbackModels(cfg),
    });
}
export function resolveAllowedModelRef(params) {
    const aliasIndex = buildModelAliasIndex({
        cfg: params.cfg,
        defaultProvider: params.defaultProvider,
    });
    return resolveAllowedModelRefFromAliasIndex({
        cfg: params.cfg,
        raw: params.raw,
        defaultProvider: params.defaultProvider,
        aliasIndex,
        getStatus: (ref) => getModelRefStatus({
            cfg: params.cfg,
            catalog: params.catalog,
            ref,
            defaultProvider: params.defaultProvider,
            defaultModel: params.defaultModel,
        }),
    });
}
