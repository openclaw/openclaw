import { i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";
import { t as PluginManifestRecord } from "./manifest-registry-CYlyjfOr.js";
import { t as ModelCatalogEntry } from "./model-catalog.types-CRpxx7uE.js";

//#region src/agents/model-thinking-default.d.ts
type ThinkLevel$1 = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive" | "max";
declare function resolveThinkingDefault(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
  catalog?: ModelCatalogEntry[];
}): ThinkLevel$1;
declare function resolveThinkingDefaultWithRuntimeCatalog(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
  loadModelCatalog: () => Promise<ModelCatalogEntry[]>;
}): Promise<ThinkLevel$1>;
//#endregion
//#region src/agents/model-selection-normalize.d.ts
type ModelRef = {
  provider: string;
  model: string;
};
declare function modelKey(provider: string, model: string): string;
declare function legacyModelKey(provider: string, model: string): string | null;
type ModelRefNormalizeOptions = {
  allowManifestNormalization?: boolean;
  allowPluginNormalization?: boolean;
  manifestPlugins?: readonly Pick<PluginManifestRecord, "modelIdNormalization">[];
};
declare function normalizeModelRef(provider: string, model: string, options?: ModelRefNormalizeOptions): ModelRef;
type ParseModelRefOptions = ModelRefNormalizeOptions;
declare function parseModelRef(raw: string, defaultProvider: string, options?: ParseModelRefOptions): ModelRef | null;
//#endregion
//#region src/agents/model-selection-shared.d.ts
type ModelAliasIndex = {
  byAlias: Map<string, {
    alias: string;
    ref: ModelRef;
  }>;
  byKey: Map<string, string[]>;
};
type ManifestNormalizationContext = {
  manifestPlugins?: readonly Pick<PluginManifestRecord, "modelIdNormalization">[];
};
declare function inferUniqueProviderFromConfiguredModels(params: {
  cfg: OpenClawConfig;
  model: string;
}): string | undefined;
declare function inferUniqueProviderFromCatalog(params: {
  catalog: readonly ModelCatalogEntry[];
  model: string;
}): string | undefined;
declare function resolveBareModelDefaultProvider(params: {
  cfg: OpenClawConfig;
  catalog: readonly ModelCatalogEntry[];
  model: string;
  defaultProvider: string;
}): string;
declare function buildConfiguredAllowlistKeys(params: {
  cfg: OpenClawConfig | undefined;
  defaultProvider: string;
}): Set<string> | null;
declare function buildModelAliasIndex(params: {
  cfg: OpenClawConfig;
  defaultProvider: string;
  allowManifestNormalization?: boolean;
  allowPluginNormalization?: boolean;
} & ManifestNormalizationContext): ModelAliasIndex;
declare function resolveModelRefFromString(params: {
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
declare function resolveConfiguredModelRef(params: {
  cfg: OpenClawConfig;
  defaultProvider: string;
  defaultModel: string;
  allowManifestNormalization?: boolean;
  allowPluginNormalization?: boolean;
}): ModelRef;
type ModelRefStatus = {
  key: string;
  inCatalog: boolean;
  allowAny: boolean;
  allowed: boolean;
};
declare function buildConfiguredModelCatalog(params: {
  cfg: OpenClawConfig;
}): ModelCatalogEntry[];
declare function resolveHooksGmailModel(params: {
  cfg: OpenClawConfig;
  defaultProvider: string;
}): ModelRef | null;
declare function normalizeModelSelection(value: unknown): string | undefined;
//#endregion
//#region src/agents/model-selection-cli.d.ts
declare function isCliProvider(provider: string, cfg?: OpenClawConfig): boolean;
//#endregion
//#region src/agents/model-selection.d.ts
type ThinkLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive" | "max";
declare function resolvePersistedOverrideModelRef(params: {
  defaultProvider?: unknown;
  overrideProvider?: unknown;
  overrideModel?: unknown;
  allowPluginNormalization?: boolean;
}): ModelRef | null;
/**
 * Runtime-first resolver for persisted model metadata.
 * Use this when callers intentionally want the last executed model identity.
 */
declare function resolvePersistedModelRef(params: {
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
declare function resolvePersistedSelectedModelRef(params: {
  defaultProvider?: unknown;
  runtimeProvider?: unknown;
  runtimeModel?: unknown;
  overrideProvider?: unknown;
  overrideModel?: unknown;
  allowPluginNormalization?: boolean;
}): ModelRef | null;
declare function normalizeStoredOverrideModel(params: {
  providerOverride?: unknown;
  modelOverride?: unknown;
}): {
  providerOverride?: string;
  modelOverride?: string;
};
declare function resolveAllowlistModelKey(raw: string, defaultProvider: string, cfg?: OpenClawConfig): string | null;
declare function resolveDefaultModelForAgent(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  allowPluginNormalization?: boolean;
}): ModelRef;
declare function canonicalizeCaseOnlyCatalogModelRef(params: {
  raw: string | undefined;
  cfg?: OpenClawConfig;
  defaultProvider: string;
  loadCatalog: () => Promise<ModelCatalogEntry[]>;
  aliasIndex?: ModelAliasIndex;
  allowManifestNormalization?: boolean;
  allowPluginNormalization?: boolean;
  preserveAuthProfile?: boolean;
}): Promise<string | undefined>;
declare function resolveSubagentConfiguredModelSelection(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): string | undefined;
declare function resolveSubagentSpawnModelSelection(params: {
  cfg: OpenClawConfig;
  agentId: string;
  modelOverride?: unknown;
}): string;
declare function buildAllowedModelSet(params: {
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
declare function getModelRefStatus(params: {
  cfg: OpenClawConfig;
  catalog: ModelCatalogEntry[];
  ref: ModelRef;
  defaultProvider: string;
  defaultModel?: string;
}): ModelRefStatus;
declare function resolveAllowedModelRef(params: {
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
declare function resolveReasoningDefault(params: {
  provider: string;
  model: string;
  catalog?: ModelCatalogEntry[];
}): "on" | "off";
//#endregion
export { modelKey as A, normalizeModelSelection as C, resolveModelRefFromString as D, resolveHooksGmailModel as E, parseModelRef as M, resolveThinkingDefault as N, ModelRef as O, resolveThinkingDefaultWithRuntimeCatalog as P, inferUniqueProviderFromConfiguredModels as S, resolveConfiguredModelRef as T, ModelRefStatus as _, normalizeStoredOverrideModel as a, buildModelAliasIndex as b, resolveDefaultModelForAgent as c, resolvePersistedSelectedModelRef as d, resolveReasoningDefault as f, ModelAliasIndex as g, isCliProvider as h, getModelRefStatus as i, normalizeModelRef as j, legacyModelKey as k, resolvePersistedModelRef as l, resolveSubagentSpawnModelSelection as m, buildAllowedModelSet as n, resolveAllowedModelRef as o, resolveSubagentConfiguredModelSelection as p, canonicalizeCaseOnlyCatalogModelRef as r, resolveAllowlistModelKey as s, ThinkLevel as t, resolvePersistedOverrideModelRef as u, buildConfiguredAllowlistKeys as v, resolveBareModelDefaultProvider as w, inferUniqueProviderFromCatalog as x, buildConfiguredModelCatalog as y };