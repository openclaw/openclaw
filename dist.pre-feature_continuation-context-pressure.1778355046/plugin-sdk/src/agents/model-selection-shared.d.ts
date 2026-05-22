import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { type ModelRef } from "./model-selection-normalize.js";
export type ModelAliasIndex = {
    byAlias: Map<string, {
        alias: string;
        ref: ModelRef;
    }>;
    byKey: Map<string, string[]>;
};
type ManifestNormalizationContext = {
    manifestPlugins?: readonly Pick<PluginManifestRecord, "modelIdNormalization">[];
};
export declare function inferUniqueProviderFromConfiguredModels(params: {
    cfg: OpenClawConfig;
    model: string;
}): string | undefined;
export declare function inferUniqueProviderFromCatalog(params: {
    catalog: readonly ModelCatalogEntry[];
    model: string;
}): string | undefined;
export declare function resolveBareModelDefaultProvider(params: {
    cfg: OpenClawConfig;
    catalog: readonly ModelCatalogEntry[];
    model: string;
    defaultProvider: string;
}): string;
export declare function resolveConfiguredOpenRouterCompatAlias(params: {
    cfg?: OpenClawConfig;
    raw: string;
    defaultProvider: string;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
} & ManifestNormalizationContext): ModelRef | null;
export declare function resolveAllowlistModelKey(params: {
    cfg?: OpenClawConfig;
    raw: string;
    defaultProvider: string;
}): string | null;
export declare function buildConfiguredAllowlistKeys(params: {
    cfg: OpenClawConfig | undefined;
    defaultProvider: string;
}): Set<string> | null;
export declare function buildModelAliasIndex(params: {
    cfg: OpenClawConfig;
    defaultProvider: string;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
} & ManifestNormalizationContext): ModelAliasIndex;
export declare function resolveModelRefFromString(params: {
    cfg?: OpenClawConfig;
    raw: string;
    defaultProvider: string;
    aliasIndex?: ModelAliasIndex;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
} & ManifestNormalizationContext): {
    ref: ModelRef;
    alias?: string;
} | null;
export declare function resolveConfiguredModelRef(params: {
    cfg: OpenClawConfig;
    defaultProvider: string;
    defaultModel: string;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
}): ModelRef;
export declare function buildAllowedModelSetWithFallbacks(params: {
    cfg: OpenClawConfig;
    catalog: ModelCatalogEntry[];
    defaultProvider: string;
    defaultModel?: string;
    fallbackModels: readonly string[];
}): {
    allowAny: boolean;
    allowedCatalog: ModelCatalogEntry[];
    allowedKeys: Set<string>;
};
export type ModelRefStatus = {
    key: string;
    inCatalog: boolean;
    allowAny: boolean;
    allowed: boolean;
};
export type ResolveAllowedModelRefResult = {
    ref: ModelRef;
    key: string;
} | {
    error: string;
};
export declare function getModelRefStatusWithFallbackModels(params: {
    cfg: OpenClawConfig;
    catalog: ModelCatalogEntry[];
    ref: ModelRef;
    defaultProvider: string;
    defaultModel?: string;
    fallbackModels: readonly string[];
}): ModelRefStatus;
export declare function resolveAllowedModelRefFromAliasIndex(params: {
    cfg: OpenClawConfig;
    raw: string;
    defaultProvider: string;
    aliasIndex: ModelAliasIndex;
    getStatus: (ref: ModelRef) => ModelRefStatus;
}): ResolveAllowedModelRefResult;
export declare function buildConfiguredModelCatalog(params: {
    cfg: OpenClawConfig;
}): ModelCatalogEntry[];
export declare function resolveHooksGmailModel(params: {
    cfg: OpenClawConfig;
    defaultProvider: string;
}): ModelRef | null;
export declare function normalizeModelSelection(value: unknown): string | undefined;
export {};
