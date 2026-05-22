import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
export { resolveThinkingDefault } from "./model-thinking-default.js";
import { type ModelRef, findNormalizedProviderKey, findNormalizedProviderValue, legacyModelKey, modelKey, normalizeModelRef, normalizeProviderId, normalizeProviderIdForAuth, parseModelRef } from "./model-selection-normalize.js";
import { buildConfiguredAllowlistKeys, buildConfiguredModelCatalog, buildModelAliasIndex, inferUniqueProviderFromCatalog, inferUniqueProviderFromConfiguredModels, normalizeModelSelection, resolveBareModelDefaultProvider, resolveConfiguredModelRef, resolveHooksGmailModel, resolveModelRefFromString, type ModelAliasIndex, type ModelRefStatus } from "./model-selection-shared.js";
export type { ModelAliasIndex, ModelRef, ModelRefStatus };
export type ThinkLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive" | "max";
export { buildConfiguredAllowlistKeys, buildConfiguredModelCatalog, buildModelAliasIndex, findNormalizedProviderKey, findNormalizedProviderValue, inferUniqueProviderFromConfiguredModels, inferUniqueProviderFromCatalog, legacyModelKey, modelKey, normalizeModelRef, normalizeModelSelection, normalizeProviderId, normalizeProviderIdForAuth, parseModelRef, resolveBareModelDefaultProvider, resolveConfiguredModelRef, resolveHooksGmailModel, resolveModelRefFromString, };
export { isCliProvider } from "./model-selection-cli.js";
export declare function resolvePersistedOverrideModelRef(params: {
    defaultProvider?: unknown;
    overrideProvider?: unknown;
    overrideModel?: unknown;
    allowPluginNormalization?: boolean;
}): ModelRef | null;
/**
 * Runtime-first resolver for persisted model metadata.
 * Use this when callers intentionally want the last executed model identity.
 */
export declare function resolvePersistedModelRef(params: {
    defaultProvider?: unknown;
    runtimeProvider?: unknown;
    runtimeModel?: unknown;
    overrideProvider?: unknown;
    overrideModel?: unknown;
    allowPluginNormalization?: boolean;
}): ModelRef | null;
/**
 * Selected-model resolver for persisted model metadata.
 * Use this for control/status/UI surfaces that should honor explicit session
 * overrides before falling back to runtime identity.
 */
export declare function resolvePersistedSelectedModelRef(params: {
    defaultProvider?: unknown;
    runtimeProvider?: unknown;
    runtimeModel?: unknown;
    overrideProvider?: unknown;
    overrideModel?: unknown;
    allowPluginNormalization?: boolean;
}): ModelRef | null;
export declare function normalizeStoredOverrideModel(params: {
    providerOverride?: unknown;
    modelOverride?: unknown;
}): {
    providerOverride?: string;
    modelOverride?: string;
};
export declare function resolveAllowlistModelKey(raw: string, defaultProvider: string, cfg?: OpenClawConfig): string | null;
export declare function resolveDefaultModelForAgent(params: {
    cfg: OpenClawConfig;
    agentId?: string;
}): ModelRef;
export declare function resolveSubagentConfiguredModelSelection(params: {
    cfg: OpenClawConfig;
    agentId: string;
}): string | undefined;
export declare function resolveSubagentSpawnModelSelection(params: {
    cfg: OpenClawConfig;
    agentId: string;
    modelOverride?: unknown;
}): string;
export declare function buildAllowedModelSet(params: {
    cfg: OpenClawConfig;
    catalog: ModelCatalogEntry[];
    defaultProvider: string;
    defaultModel?: string;
    agentId?: string;
}): {
    allowAny: boolean;
    allowedCatalog: ModelCatalogEntry[];
    allowedKeys: Set<string>;
};
export declare function getModelRefStatus(params: {
    cfg: OpenClawConfig;
    catalog: ModelCatalogEntry[];
    ref: ModelRef;
    defaultProvider: string;
    defaultModel?: string;
}): ModelRefStatus;
export declare function resolveAllowedModelRef(params: {
    cfg: OpenClawConfig;
    catalog: ModelCatalogEntry[];
    raw: string;
    defaultProvider: string;
    defaultModel?: string;
}): {
    ref: ModelRef;
    key: string;
} | {
    error: string;
};
/** Default reasoning level when session/directive do not set it: "on" if model supports reasoning, else "off". */
export declare function resolveReasoningDefault(params: {
    provider: string;
    model: string;
    catalog?: ModelCatalogEntry[];
}): "on" | "off";
