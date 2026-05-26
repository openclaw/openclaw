import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { type ModelManifestNormalizationContext, type ModelRef } from "./model-selection-normalize.js";
type ModelManifestPlugins = ModelManifestNormalizationContext["manifestPlugins"];
export type ModelAliasIndex = {
    byAlias: Map<string, {
        alias: string;
        ref: ModelRef;
    }>;
    byKey: Map<string, string[]>;
};
export declare function inferUniqueProviderFromConfiguredModels(params: {
    cfg: OpenClawConfig;
    model: string;
} & ModelManifestNormalizationContext): string | undefined;
export declare function inferUniqueProviderFromCatalog(params: {
    catalog: readonly ModelCatalogEntry[];
    model: string;
}): string | undefined;
export declare function resolveBareModelDefaultProvider(params: {
    cfg: OpenClawConfig;
    catalog: readonly ModelCatalogEntry[];
    model: string;
    defaultProvider: string;
} & ModelManifestNormalizationContext): string;
export declare function resolveConfiguredOpenRouterCompatAlias(params: {
    cfg?: OpenClawConfig;
    raw: string;
    defaultProvider: string;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
} & ModelManifestNormalizationContext): ModelRef | null;
export declare function resolveAllowlistModelKey(params: {
    cfg?: OpenClawConfig;
    raw: string;
    defaultProvider: string;
} & ModelManifestNormalizationContext): string | null;
export declare function buildConfiguredAllowlistKeys(params: {
    cfg: OpenClawConfig | undefined;
    defaultProvider: string;
} & ModelManifestNormalizationContext): Set<string> | null;
export declare function buildModelAliasIndex(params: {
    cfg: OpenClawConfig;
    defaultProvider: string;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
} & ModelManifestNormalizationContext): ModelAliasIndex;
export declare function resolveModelRefFromString(params: {
    cfg?: OpenClawConfig;
    raw: string;
    defaultProvider: string;
    aliasIndex?: ModelAliasIndex;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
} & ModelManifestNormalizationContext): {
    ref: ModelRef;
    alias?: string;
} | null;
export declare function resolveConfiguredModelRef(params: {
    cfg: OpenClawConfig;
    defaultProvider: string;
    defaultModel: string;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
} & ModelManifestNormalizationContext): ModelRef;
export declare function buildAllowedModelSetWithFallbacks(params: {
    cfg: OpenClawConfig;
    catalog: ModelCatalogEntry[];
    defaultProvider: string;
    defaultModel?: string;
    fallbackModels: readonly string[];
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
} & ModelManifestNormalizationContext): {
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
} & ModelManifestNormalizationContext): ModelRefStatus;
export declare function resolveAllowedModelRefFromAliasIndex(params: {
    cfg: OpenClawConfig;
    raw: string;
    defaultProvider: string;
    aliasIndex: ModelAliasIndex;
    getStatus: (ref: ModelRef) => ModelRefStatus;
} & ModelManifestNormalizationContext): ResolveAllowedModelRefResult;
export declare function hasConfiguredProviderModelRows(cfg: OpenClawConfig): boolean;
export declare function buildConfiguredModelCatalog(params: {
    cfg: OpenClawConfig;
    workspaceDir?: string;
    manifestPlugins?: ModelManifestPlugins;
}): ModelCatalogEntry[];
export declare function resolveHooksGmailModel(params: {
    cfg: OpenClawConfig;
    defaultProvider: string;
} & ModelManifestNormalizationContext): ModelRef | null;
export declare function normalizeModelSelection(value: unknown): string | undefined;
export declare function parseConfiguredModelVisibilityEntries(params: {
    cfg?: OpenClawConfig;
}): {
    exactModelRefs: string[];
    providerWildcards: Set<string>;
    hasEntries: boolean;
};
export declare function providerWildcardModelKey(provider: string): string;
export declare function isModelKeyAllowedBySet(allowedKeys: ReadonlySet<string>, key: string): boolean;
export declare function resolveAllowedModelSelection(params: {
    provider: string;
    model: string;
    allowAny: boolean;
    allowedKeys: ReadonlySet<string>;
    allowedCatalog: readonly ModelCatalogEntry[];
} & ModelManifestNormalizationContext): ModelRef | null;
export type ModelVisibilityPolicy = {
    allowAny: boolean;
    allowedCatalog: ModelCatalogEntry[];
    allowedKeys: Set<string>;
    exactModelRefs: readonly string[];
    providerWildcards: ReadonlySet<string>;
    hasConfiguredEntries: boolean;
    hasProviderWildcards: boolean;
    allowsKey: (key: string) => boolean;
    allows: (ref: {
        provider: string;
        model: string;
    }) => boolean;
    resolveSelection: (ref: {
        provider: string;
        model: string;
    }) => ModelRef | null;
    visibleCatalog: (params: {
        catalog: readonly ModelCatalogEntry[];
        defaultVisibleCatalog: readonly ModelCatalogEntry[];
        view?: "default" | "configured" | "all";
    }) => ModelCatalogEntry[];
};
export declare function createModelVisibilityPolicyWithFallbacks(params: {
    cfg: OpenClawConfig;
    catalog: ModelCatalogEntry[];
    defaultProvider: string;
    defaultModel?: string;
    fallbackModels: readonly string[];
} & ModelManifestNormalizationContext): ModelVisibilityPolicy;
export {};
