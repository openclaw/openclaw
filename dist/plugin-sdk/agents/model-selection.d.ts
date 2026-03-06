import type { OpenClawConfig } from "../config/config.js";
import type { ModelCatalogEntry } from "./model-catalog.js";
export type ModelRef = {
    provider: string;
    model: string;
};
export type ThinkLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive";
export type ModelAliasIndex = {
    byAlias: Map<string, {
        alias: string;
        ref: ModelRef;
    }>;
    byKey: Map<string, string[]>;
};
export declare function modelKey(provider: string, model: string): string;
export declare function normalizeProviderId(provider: string): string;
/** Normalize provider ID for auth lookup. Coding-plan variants share auth with base. */
export declare function normalizeProviderIdForAuth(provider: string): string;
export declare function findNormalizedProviderValue<T>(entries: Record<string, T> | undefined, provider: string): T | undefined;
export declare function findNormalizedProviderKey(entries: Record<string, unknown> | undefined, provider: string): string | undefined;
export declare function isCliProvider(provider: string, cfg?: OpenClawConfig): boolean;
export declare function normalizeModelRef(provider: string, model: string): ModelRef;
export declare function parseModelRef(raw: string, defaultProvider: string): ModelRef | null;
export declare function inferUniqueProviderFromConfiguredModels(params: {
    cfg: OpenClawConfig;
    model: string;
}): string | undefined;
export declare function resolveAllowlistModelKey(raw: string, defaultProvider: string): string | null;
export declare function buildConfiguredAllowlistKeys(params: {
    cfg: OpenClawConfig | undefined;
    defaultProvider: string;
}): Set<string> | null;
export declare function buildModelAliasIndex(params: {
    cfg: OpenClawConfig;
    defaultProvider: string;
}): ModelAliasIndex;
export declare function resolveModelRefFromString(params: {
    raw: string;
    defaultProvider: string;
    aliasIndex?: ModelAliasIndex;
}): {
    ref: ModelRef;
    alias?: string;
} | null;
export declare function resolveConfiguredModelRef(params: {
    cfg: OpenClawConfig;
    defaultProvider: string;
    defaultModel: string;
}): ModelRef;
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
export declare function resolveThinkingDefault(params: {
    cfg: OpenClawConfig;
    provider: string;
    model: string;
    catalog?: ModelCatalogEntry[];
}): ThinkLevel;
/** Default reasoning level when session/directive do not set it: "on" if model supports reasoning, else "off". */
export declare function resolveReasoningDefault(params: {
    provider: string;
    model: string;
    catalog?: ModelCatalogEntry[];
}): "on" | "off";
/**
 * Resolve the model configured for Gmail hook processing.
 * Returns null if hooks.gmail.model is not set.
 */
export declare function resolveHooksGmailModel(params: {
    cfg: OpenClawConfig;
    defaultProvider: string;
}): ModelRef | null;
/**
 * Normalize a model selection value (string or `{primary?: string}`) to a
 * plain trimmed string.  Returns `undefined` when the input is empty/missing.
 * Shared by sessions-spawn and cron isolated-agent model resolution.
 */
export declare function normalizeModelSelection(value: unknown): string | undefined;
