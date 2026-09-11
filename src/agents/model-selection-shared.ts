/**
 * Shared model-selection resolution, alias, allowlist, and visibility logic.
 */
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { sanitizeForLog, stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import {
  computeModelPolicyAllowlist,
  hasExplicitModelPolicyAllow,
} from "../config/model-policy-allowlist-migration.js";
import { parseModelPolicyWildcardRef } from "../config/model-policy-ref.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { loadManifestMetadataSnapshot } from "../plugins/manifest-contract-eligibility.js";
import { getActivePluginRegistryWorkspaceDirFromState } from "../plugins/runtime-state.js";
import { dedupeByKey, indexFirstByKey } from "../shared/dedupe-by-key.js";
import { resolveAgentConfig } from "./agent-scope-config.js";
import { resolveConfiguredProviderFallback } from "./configured-provider-fallback.js";
import { DEFAULT_PROVIDER } from "./defaults.js";
import { findModelCatalogEntry } from "./model-catalog-lookup.js";
import { overlayCatalogMetadata } from "./model-catalog-metadata.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";
import {
  createConfiguredProviderCatalogModelIdNormalizer,
  normalizeConfiguredProviderCatalogModelId,
  type ModelManifestNormalizationContext,
  type ModelRef,
  modelKey,
  normalizeModelRef,
  normalizeProviderId,
} from "./model-ref-shared.js";
import { findNormalizedProviderValue, parseModelRef } from "./model-selection-normalize.js";
import { resolveModelCatalogIdentityKey } from "./openai-model-routes.js";

export { resolvePrimaryStringValue as normalizeModelSelection } from "@openclaw/normalization-core/string-coerce";

// Shared model-selection helpers for config aliases, allowlists, provider
// inference, and configured catalog rows used by CLI and runtime selectors.
let log: ReturnType<typeof createSubsystemLogger> | null = null;

function getLog(): ReturnType<typeof createSubsystemLogger> {
  log ??= createSubsystemLogger("model-selection");
  return log;
}

const OPENROUTER_COMPAT_FREE_ALIAS = "openrouter:free";
type ModelManifestPlugins = ModelManifestNormalizationContext["manifestPlugins"];

export type ModelAliasIndex = {
  byAlias: Map<string, { alias: string; ref: ModelRef }>;
  byProviderAlias?: Map<string, { alias: string; ref: ModelRef }>;
  byKey: Map<string, string[]>;
  disabledKeys?: Set<string>;
};

type ModelManifestPluginContext = {
  peek: () => ModelManifestPlugins;
  get: () => ModelManifestPlugins;
};

type ModelAliasCandidate = {
  keyRaw: string;
  alias: string;
};

type EffectiveModelAlias = ModelAliasCandidate & {
  ref: ModelRef;
};

function isStaticDefaultProviderAliasCandidate(
  candidate: ModelAliasCandidate,
  cfg: OpenClawConfig,
): boolean {
  const raw = candidate.keyRaw.trim();
  const slash = raw.indexOf("/");
  return (
    slash > 0 &&
    slash < raw.length - 1 &&
    normalizeProviderId(raw.slice(0, slash)) === normalizeProviderId(DEFAULT_PROVIDER) &&
    !findExactConfiguredProviderRefParts({ cfg, raw })
  );
}

type ExactConfiguredProviderRefParts = {
  configuredProvider: string;
  modelRaw: string;
};

function providerAliasKey(provider: string, alias: string): string {
  return `${normalizeProviderId(provider)}/${normalizeLowercaseStringOrEmpty(alias)}`;
}

function hasSlashFormModelRef(raw: string): boolean {
  const trimmed = raw.trim();
  const slash = trimmed.indexOf("/");
  return slash > 0 && slash < trimmed.length - 1;
}

function resolveManifestPluginsForModelIdNormalization(params: {
  cfg: OpenClawConfig;
  workspaceDir?: string;
  manifestPlugins?: ModelManifestPlugins;
  allowManifestNormalization?: boolean;
}): ModelManifestPlugins {
  if (params.allowManifestNormalization === false || params.manifestPlugins !== undefined) {
    return params.manifestPlugins;
  }
  const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState();
  if (!workspaceDir) {
    const currentManifestPlugins = getCurrentPluginMetadataSnapshot({
      config: params.cfg,
      env: process.env,
    });
    if (currentManifestPlugins) {
      return currentManifestPlugins;
    }
  }
  return loadManifestMetadataSnapshot({
    config: params.cfg,
    env: process.env,
    ...(workspaceDir ? { workspaceDir } : {}),
  });
}

function createModelManifestPluginContext(params: {
  cfg: OpenClawConfig;
  workspaceDir?: string;
  manifestPlugins?: ModelManifestPlugins;
  allowManifestNormalization?: boolean;
}): ModelManifestPluginContext {
  let manifestPlugins = params.manifestPlugins;
  let resolved =
    params.allowManifestNormalization === false || params.manifestPlugins !== undefined;
  return {
    peek: () => manifestPlugins,
    get: () => {
      // Manifest metadata can touch plugin registries. Defer that work until a
      // path actually needs plugin/provider normalization.
      if (!resolved) {
        manifestPlugins = resolveManifestPluginsForModelIdNormalization(params);
        resolved = true;
      }
      return manifestPlugins;
    },
  };
}

function listConfiguredModelMaps(cfg: OpenClawConfig, agentId?: string) {
  return [
    { models: cfg.agents?.defaults?.models },
    ...(agentId ? [{ models: resolveAgentConfig(cfg, agentId)?.models }] : []),
  ];
}

export function listModelAliasCandidates(cfg: OpenClawConfig, agentId?: string) {
  return listConfiguredModelMaps(cfg, agentId).flatMap(({ models }) =>
    Object.entries(models ?? {}).flatMap(([keyRaw, entryRaw]) => {
      if (parseModelPolicyWildcardRef(keyRaw)) {
        return [];
      }
      if (!entryRaw || typeof entryRaw !== "object" || !Object.hasOwn(entryRaw, "alias")) {
        return [];
      }
      const alias = normalizeOptionalString((entryRaw as { alias?: unknown }).alias) ?? "";
      return [{ keyRaw, alias }];
    }),
  );
}

function buildEffectiveModelAliases(
  params: Omit<BuildModelAliasIndexParams, "manifestPlugins"> & {
    manifestPluginContext: ModelManifestPluginContext;
  },
): { aliases: EffectiveModelAlias[]; disabledKeys: Set<string> } {
  const aliasesByKey = new Map<string, EffectiveModelAlias | null>();
  const candidates = listModelAliasCandidates(params.cfg, params.agentId);
  if (candidates.length === 0) {
    return { aliases: [], disabledKeys: new Set() };
  }
  // One alias index must use one manifest generation. Skip discovery only when
  // every candidate is a default-provider identity transform.
  const useStaticDefaultProviderAliases =
    params.allowManifestNormalization !== false &&
    candidates.every((candidate) => isStaticDefaultProviderAliasCandidate(candidate, params.cfg)) &&
    params.manifestPluginContext.peek() === undefined &&
    !getActivePluginRegistryWorkspaceDirFromState() &&
    !getCurrentPluginMetadataSnapshot({ config: params.cfg, env: process.env });
  const manifestPlugins = useStaticDefaultProviderAliases
    ? undefined
    : params.manifestPluginContext.get();
  for (const candidate of candidates) {
    const ref = parseModelRefWithCompatAlias({
      cfg: params.cfg,
      agentId: params.agentId,
      raw: candidate.keyRaw,
      defaultProvider: params.defaultProvider,
      allowManifestNormalization: useStaticDefaultProviderAliases
        ? false
        : params.allowManifestNormalization,
      allowPluginNormalization: useStaticDefaultProviderAliases
        ? false
        : params.allowPluginNormalization,
      manifestPlugins,
    });
    if (!ref) {
      continue;
    }
    const key = modelKey(ref.provider, ref.model);
    // Reinsert replacements so agent-owned aliases win duplicate-alias lookup
    // while an omitted agent alias leaves the inherited record untouched.
    aliasesByKey.delete(key);
    aliasesByKey.set(key, candidate.alias ? { ...candidate, ref } : null);
  }
  return {
    aliases: [...aliasesByKey.values()].filter(
      (alias): alias is EffectiveModelAlias => alias !== null,
    ),
    disabledKeys: new Set(
      [...aliasesByKey].flatMap(([key, alias]) => (alias === null ? [key] : [])),
    ),
  };
}

function findModelAliasCandidate(
  candidates: readonly EffectiveModelAlias[],
  raw: string,
): EffectiveModelAlias | undefined {
  const aliasKey = normalizeLowercaseStringOrEmpty(raw);
  let match: EffectiveModelAlias | undefined;
  for (const candidate of candidates) {
    if (normalizeLowercaseStringOrEmpty(candidate.alias) === aliasKey) {
      match = candidate;
    }
  }
  return match;
}

function sanitizeModelWarningValue(value: string): string {
  const stripped = value ? stripAnsi(value) : "";
  let controlBoundary = -1;
  for (let index = 0; index < stripped.length; index += 1) {
    const code = stripped.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      controlBoundary = index;
      break;
    }
  }
  if (controlBoundary === -1) {
    return sanitizeForLog(stripped);
  }
  return sanitizeForLog(stripped.slice(0, controlBoundary));
}

// Metadata follows literal rows, even when display keys collapse provider-prefixed IDs.
function modelCatalogEntryKey(entry: Pick<ModelCatalogEntry, "provider" | "id">): string {
  return JSON.stringify([entry.provider.trim(), entry.id.trim()]);
}

function mergeModelCatalogEntries(params: {
  primary: readonly ModelCatalogEntry[];
  secondary: readonly ModelCatalogEntry[];
}): ModelCatalogEntry[] {
  const merged = [...params.primary];
  const seen = new Set(merged.map(modelCatalogEntryKey));
  for (const entry of params.secondary) {
    const key = modelCatalogEntryKey(entry);
    if (seen.has(key)) {
      continue;
    }
    merged.push(entry);
    seen.add(key);
  }
  return merged;
}

/** One scope ranks exact IDs ahead of folded matches; ambiguity remains a match. */
function createModelProviderMatcher(raw: string) {
  const model = raw.trim();
  const foldedModel = normalizeLowercaseStringOrEmpty(model);
  const exact = new Set<string>();
  const folded = new Set<string>();
  return {
    add(provider: string, ...ids: string[]) {
      const providerId = normalizeProviderId(provider);
      if (!model || !providerId) {
        return;
      }
      if (ids.some((id) => id.trim() === model)) {
        exact.add(providerId);
      } else if (ids.some((id) => normalizeLowercaseStringOrEmpty(id) === foldedModel)) {
        folded.add(providerId);
      }
    },
    get matches() {
      return exact.size > 0 ? exact : folded;
    },
  };
}

/** Infer a unique provider for a bare model from configured model rows. */
export function inferUniqueProviderFromConfiguredModels(
  params: {
    cfg: OpenClawConfig;
    model: string;
    agentId?: string;
    allowManifestNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): string | undefined {
  if (!params.model.trim()) {
    return undefined;
  }
  const collectModelMapProviders = (models: Record<string, unknown> | undefined) => {
    const matcher = createModelProviderMatcher(params.model);
    for (const key of Object.keys(models ?? {})) {
      const ref = key.trim();
      if (!ref.includes("/") || ref.endsWith("/*")) {
        continue;
      }
      const parsed = parseModelRef(ref, DEFAULT_PROVIDER, {
        allowManifestNormalization: params.allowManifestNormalization,
        allowPluginNormalization: false,
        manifestPlugins: params.manifestPlugins,
      });
      if (parsed) {
        matcher.add(parsed.provider, parsed.model);
      }
    }
    return matcher;
  };
  if (params.agentId) {
    const { matches } = collectModelMapProviders(
      resolveAgentConfig(params.cfg, params.agentId)?.models,
    );
    if (matches.size > 0) {
      return matches.size === 1 ? matches.values().next().value : undefined;
    }
  }
  const matcher = collectModelMapProviders(params.cfg.agents?.defaults?.models);
  const normalizeModelId = createConfiguredProviderCatalogModelIdNormalizer({
    allowManifestNormalization: params.allowManifestNormalization,
    manifestPlugins: params.manifestPlugins,
  });
  for (const [providerId, providerConfig] of Object.entries(params.cfg.models?.providers ?? {})) {
    if (!Array.isArray(providerConfig?.models)) {
      continue;
    }
    for (const entry of providerConfig.models) {
      const modelId = entry?.id?.trim();
      if (modelId) {
        matcher.add(providerId, modelId, normalizeModelId(providerId, modelId));
      }
    }
  }
  const { matches } = matcher;
  return matches.size === 1 ? matches.values().next().value : undefined;
}

/** Infer a unique provider for a bare model from a provider catalog. */
function inferUniqueProviderFromCatalog(params: {
  catalog: readonly ModelCatalogEntry[];
  model: string;
}): string | undefined {
  const matcher = createModelProviderMatcher(params.model);
  for (const entry of params.catalog) {
    matcher.add(entry.provider, entry.id);
  }
  const { matches } = matcher;
  return matches.size === 1 ? matches.values().next().value : undefined;
}

/** Resolve the provider used when a model string omits provider/id syntax. */
export function resolveBareModelDefaultProvider(
  params: {
    cfg: OpenClawConfig;
    catalog: readonly ModelCatalogEntry[];
    model: string;
    defaultProvider: string;
    agentId?: string;
  } & ModelManifestNormalizationContext,
): string {
  return (
    inferUniqueProviderFromConfiguredModels({
      cfg: params.cfg,
      model: params.model,
      agentId: params.agentId,
      manifestPlugins: params.manifestPlugins,
    }) ??
    inferUniqueProviderFromCatalog({ catalog: params.catalog, model: params.model }) ??
    params.defaultProvider
  );
}

function isConcreteOpenRouterFreeModelRef(ref: ModelRef): boolean {
  return ref.provider === "openrouter" && ref.model.includes("/") && ref.model.endsWith(":free");
}

function resolveConfiguredOpenRouterCompatFreeRef(
  params: {
    cfg: OpenClawConfig;
    agentId?: string;
    defaultProvider: string;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): ModelRef | null {
  const agentModels = params.agentId
    ? resolveAgentConfig(params.cfg, params.agentId)?.models
    : undefined;
  for (const models of [agentModels, params.cfg.agents?.defaults?.models]) {
    for (const raw of Object.keys(models ?? {})) {
      if (!raw.includes("/")) {
        continue;
      }
      const parsed = parseModelRef(raw, params.defaultProvider, {
        allowManifestNormalization: params.allowManifestNormalization,
        allowPluginNormalization: params.allowPluginNormalization,
        manifestPlugins: params.manifestPlugins,
      });
      if (parsed && isConcreteOpenRouterFreeModelRef(parsed)) {
        return parsed;
      }
    }
  }

  const openrouterProviderConfig = findNormalizedProviderValue(
    params.cfg.models?.providers,
    "openrouter",
  );
  for (const entry of openrouterProviderConfig?.models ?? []) {
    const modelId = entry?.id?.trim();
    if (!modelId || !modelId.includes("/") || !modelId.endsWith(":free")) {
      continue;
    }
    return normalizeModelRef("openrouter", modelId, {
      allowManifestNormalization: params.allowManifestNormalization,
      allowPluginNormalization: params.allowPluginNormalization,
      manifestPlugins: params.manifestPlugins,
    });
  }

  return null;
}

/** Resolve OpenRouter compatibility aliases such as openrouter:auto/free. */
function resolveConfiguredOpenRouterCompatAlias(
  params: {
    cfg?: OpenClawConfig;
    agentId?: string;
    raw: string;
    defaultProvider: string;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): ModelRef | null {
  const normalized = normalizeLowercaseStringOrEmpty(params.raw);
  if (normalized === "openrouter:auto") {
    return normalizeModelRef("openrouter", "auto", {
      allowManifestNormalization: params.allowManifestNormalization,
      allowPluginNormalization: params.allowPluginNormalization,
      manifestPlugins: params.manifestPlugins,
    });
  }
  if (normalized !== OPENROUTER_COMPAT_FREE_ALIAS || !params.cfg) {
    return null;
  }
  return resolveConfiguredOpenRouterCompatFreeRef({
    cfg: params.cfg,
    agentId: params.agentId,
    defaultProvider: params.defaultProvider,
    allowManifestNormalization: params.allowManifestNormalization,
    allowPluginNormalization: params.allowPluginNormalization,
    manifestPlugins: params.manifestPlugins,
  });
}

function parseModelRefWithCompatAlias(
  params: {
    cfg?: OpenClawConfig;
    agentId?: string;
    raw: string;
    defaultProvider: string;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): ModelRef | null {
  const exactConfiguredProviderRef = resolveExactConfiguredProviderRef(params);
  const exactDefaultProviderRef = params.raw.includes("/")
    ? null
    : resolveExactConfiguredProviderRef({
        ...params,
        raw: `${params.defaultProvider}/${params.raw}`,
      });
  return (
    resolveConfiguredOpenRouterCompatAlias(params) ??
    exactConfiguredProviderRef ??
    exactDefaultProviderRef ??
    parseModelRef(params.raw, params.defaultProvider, {
      allowManifestNormalization: params.allowManifestNormalization,
      allowPluginNormalization: params.allowPluginNormalization,
      manifestPlugins: params.manifestPlugins,
    })
  );
}

function findExactConfiguredProviderRefParts(params: {
  cfg?: OpenClawConfig;
  raw: string;
}): ExactConfiguredProviderRefParts | null {
  const slash = params.raw.indexOf("/");
  if (slash <= 0 || !params.cfg?.models?.providers) {
    return null;
  }
  const providerRaw = params.raw.slice(0, slash).trim();
  const modelRaw = params.raw.slice(slash + 1).trim();
  if (!providerRaw || !modelRaw) {
    return null;
  }
  const providerKey = normalizeLowercaseStringOrEmpty(providerRaw);
  const exactConfigured = Object.entries(params.cfg.models.providers).find(
    ([key]) => normalizeLowercaseStringOrEmpty(key) === providerKey,
  );
  if (!exactConfigured) {
    return null;
  }
  const [configuredProvider, providerConfig] = exactConfigured;
  const normalizedConfiguredProvider = normalizeProviderId(configuredProvider);
  const apiOwner =
    typeof providerConfig?.api === "string" ? normalizeProviderId(providerConfig.api) : "";
  if (!apiOwner || apiOwner === normalizedConfiguredProvider) {
    return null;
  }
  return { configuredProvider, modelRaw };
}

function normalizeExactConfiguredProviderRef(
  parts: ExactConfiguredProviderRefParts,
  params: {
    allowManifestNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): ModelRef {
  const { configuredProvider, modelRaw } = parts;
  const provider = normalizeLowercaseStringOrEmpty(configuredProvider);
  return {
    provider,
    model: normalizeConfiguredProviderCatalogModelId(provider, modelRaw.trim(), {
      allowManifestNormalization: params.allowManifestNormalization,
      manifestPlugins: params.manifestPlugins,
    }),
  };
}

function resolveExactConfiguredProviderRef(
  params: {
    cfg?: OpenClawConfig;
    raw: string;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): ModelRef | null {
  const exactConfigured = findExactConfiguredProviderRefParts({
    cfg: params.cfg,
    raw: params.raw,
  });
  if (!exactConfigured) {
    return null;
  }
  return normalizeExactConfiguredProviderRef(exactConfigured, params);
}

type BuildModelAliasIndexParams = {
  cfg: OpenClawConfig;
  defaultProvider: string;
  agentId?: string;
  allowManifestNormalization?: boolean;
  allowPluginNormalization?: boolean;
} & ModelManifestNormalizationContext;

function buildModelAliasIndexWithManifestContext(
  params: Omit<BuildModelAliasIndexParams, "manifestPlugins"> & {
    manifestPluginContext: ModelManifestPluginContext;
  },
): ModelAliasIndex {
  const byAlias = new Map<string, { alias: string; ref: ModelRef }>();
  const byProviderAlias = new Map<string, { alias: string; ref: ModelRef }>();
  const byKey = new Map<string, string[]>();
  const { aliases, disabledKeys } = buildEffectiveModelAliases(params);
  if (aliases.length === 0) {
    return { byAlias, byProviderAlias, byKey, disabledKeys };
  }

  for (const { alias, ref } of aliases) {
    const aliasKey = normalizeLowercaseStringOrEmpty(alias);
    const match = { alias, ref };
    const key = modelKey(ref.provider, ref.model);
    byAlias.set(aliasKey, match);
    // Bare aliases retain their existing last-wins behavior. Provider-qualified
    // aliases stay scoped so duplicate display names cannot select another provider.
    byProviderAlias.set(providerAliasKey(ref.provider, alias), match);
    byKey.set(key, [alias]);
  }

  return { byAlias, byProviderAlias, byKey, disabledKeys };
}

/** Build lookup maps from user-facing aliases to normalized model refs. */
export function buildModelAliasIndex(params: BuildModelAliasIndexParams): ModelAliasIndex {
  return buildModelAliasIndexWithManifestContext({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
    agentId: params.agentId,
    allowManifestNormalization: params.allowManifestNormalization,
    allowPluginNormalization: params.allowPluginNormalization,
    manifestPluginContext: createModelManifestPluginContext(params),
  });
}

type ModelCatalogMetadata = {
  configuredByKey: Map<string, ModelCatalogEntry>;
  aliasByKey: Map<string, string>;
};

function buildModelCatalogMetadata(params: {
  configuredCatalog: readonly ModelCatalogEntry[];
  aliasIndex: ModelAliasIndex;
}): ModelCatalogMetadata {
  const configuredByKey = new Map<string, ModelCatalogEntry>();
  for (const entry of params.configuredCatalog) {
    configuredByKey.set(modelCatalogEntryKey(entry), entry);
  }

  const aliasByKey = new Map(
    [...params.aliasIndex.byKey].flatMap(([key, aliases]) => {
      const alias = aliases.at(-1);
      return alias ? [[key, alias] as const] : [];
    }),
  );

  return { configuredByKey, aliasByKey };
}

function applyModelCatalogMetadata(params: {
  entry: ModelCatalogEntry;
  metadata: ModelCatalogMetadata;
}): ModelCatalogEntry {
  const configuredEntry = params.metadata.configuredByKey.get(modelCatalogEntryKey(params.entry));
  const alias = params.metadata.aliasByKey.get(modelKey(params.entry.provider, params.entry.id));
  if (!configuredEntry && !alias) {
    return params.entry;
  }
  const entry = configuredEntry
    ? {
        ...overlayCatalogMetadata(params.entry, configuredEntry, {
          preserveBaseCompat: true,
          preserveBaseRoute: true,
        }),
        name: configuredEntry.name,
      }
    : params.entry;
  return alias ? { ...entry, alias } : entry;
}

export function resolveModelRefFromString(
  params: {
    cfg?: OpenClawConfig;
    agentId?: string;
    raw: string;
    defaultProvider: string;
    aliasIndex?: ModelAliasIndex;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): { ref: ModelRef; alias?: string } | null {
  const { model } = splitTrailingAuthProfile(params.raw);
  if (!model) {
    return null;
  }
  const aliasKey = normalizeLowercaseStringOrEmpty(model);
  const aliasMatch = params.aliasIndex?.byAlias.get(aliasKey);
  if (aliasMatch) {
    return { ref: aliasMatch.ref, alias: aliasMatch.alias };
  }
  const slash = model.indexOf("/");
  if (slash > 0) {
    const providerAliasMatch = params.aliasIndex?.byProviderAlias?.get(
      providerAliasKey(model.slice(0, slash), model.slice(slash + 1)),
    );
    if (providerAliasMatch) {
      return { ref: providerAliasMatch.ref, alias: providerAliasMatch.alias };
    }
  }
  const parsed = parseModelRefWithCompatAlias({
    cfg: params.cfg,
    agentId: params.agentId,
    raw: model,
    defaultProvider: params.defaultProvider,
    allowManifestNormalization: params.allowManifestNormalization,
    allowPluginNormalization: params.allowPluginNormalization,
    manifestPlugins: params.manifestPlugins,
  });
  if (!parsed) {
    return null;
  }
  return { ref: parsed };
}

/** Resolves legacy provider/model pairs whose model field may still contain an alias. */
export function resolveModelAliasFromPair(
  params: {
    cfg?: OpenClawConfig;
    agentId?: string;
    provider: string;
    model: string;
    defaultProvider: string;
    aliasIndex?: ModelAliasIndex;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): ModelRef | null {
  const bareAlias = resolveModelRefFromString({
    ...params,
    raw: params.model,
    defaultProvider: params.provider,
  });
  const providerAlias = resolveModelRefFromString({
    ...params,
    raw: `${params.provider}/${params.model}`,
  });
  if (providerAlias?.alias) {
    return providerAlias.ref;
  }
  const provider = normalizeProviderId(params.provider);
  return bareAlias?.alias &&
    (normalizeProviderId(bareAlias.ref.provider) === provider ||
      provider === normalizeProviderId(params.defaultProvider))
    ? bareAlias.ref
    : null;
}

/** Resolve the default configured model ref, including aliases and fallback provider rows. */
export function resolveConfiguredModelRef(
  params: {
    cfg: OpenClawConfig;
    agentId?: string;
    defaultProvider: string;
    defaultModel: string;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): ModelRef {
  const rawModel =
    (params.agentId
      ? resolveAgentModelPrimaryValue(resolveAgentConfig(params.cfg, params.agentId)?.model)
      : undefined) ??
    resolveAgentModelPrimaryValue(params.cfg.agents?.defaults?.model) ??
    "";
  if (rawModel) {
    const trimmed = rawModel.trim();
    const { model: modelWithoutProfile } = splitTrailingAuthProfile(trimmed);
    const manifestPluginContext = createModelManifestPluginContext(params);
    const profileStripped = Boolean(modelWithoutProfile && modelWithoutProfile !== trimmed);
    const aliasKeys = new Set(
      [trimmed, ...(profileStripped ? [modelWithoutProfile] : [])].map(
        normalizeLowercaseStringOrEmpty,
      ),
    );
    const hasPossibleAlias = listModelAliasCandidates(params.cfg, params.agentId).some(
      (candidate) => aliasKeys.has(normalizeLowercaseStringOrEmpty(candidate.alias)),
    );
    // Resolving alias targets can require workspace manifests. Keep ordinary
    // primary selection on the static path when it cannot match an alias.
    const aliasCandidates = hasPossibleAlias
      ? buildEffectiveModelAliases({
          cfg: params.cfg,
          agentId: params.agentId,
          defaultProvider: params.defaultProvider,
          allowManifestNormalization: params.allowManifestNormalization,
          allowPluginNormalization: params.allowPluginNormalization,
          manifestPluginContext,
        }).aliases
      : [];
    const exactAliasCandidate = findModelAliasCandidate(aliasCandidates, trimmed);
    const strippedAliasCandidate = profileStripped
      ? findModelAliasCandidate(aliasCandidates, modelWithoutProfile)
      : undefined;
    const profileAliasCandidate = profileStripped
      ? (exactAliasCandidate ?? strippedAliasCandidate)
      : undefined;
    if (profileAliasCandidate) {
      // Auth-profile suffixes are not part of alias matching; resolve the alias
      // target while preserving the provider/model semantics of the key.
      return profileAliasCandidate.ref;
    }
    const primaryWithoutProfile = modelWithoutProfile || trimmed;
    const exactConfiguredPrimary = findExactConfiguredProviderRefParts({
      cfg: params.cfg,
      raw: primaryWithoutProfile,
    });
    if (exactConfiguredPrimary) {
      return normalizeExactConfiguredProviderRef(exactConfiguredPrimary, {
        allowManifestNormalization: params.allowManifestNormalization,
        manifestPlugins: manifestPluginContext.get(),
      });
    }
    const aliasCandidate = profileStripped ? undefined : exactAliasCandidate;
    const manifestPlugins = manifestPluginContext.peek();
    if (
      aliasCandidate &&
      hasSlashFormModelRef(primaryWithoutProfile) &&
      !hasSlashFormModelRef(aliasCandidate.keyRaw)
    ) {
      const primaryRef = parseModelRefWithCompatAlias({
        cfg: params.cfg,
        agentId: params.agentId,
        raw: primaryWithoutProfile,
        defaultProvider: params.defaultProvider,
        allowManifestNormalization: params.allowManifestNormalization,
        allowPluginNormalization: params.allowPluginNormalization,
        manifestPlugins: manifestPluginContext.get(),
      });
      if (primaryRef) {
        return primaryRef;
      }
    }
    if (aliasCandidate) {
      return aliasCandidate.ref;
    }

    if (!trimmed.includes("/")) {
      const normalizedTrimmed = normalizeLowercaseStringOrEmpty(trimmed);
      const needsOpenRouterCompatManifestPlugins =
        normalizedTrimmed === "openrouter:auto" ||
        normalizedTrimmed === OPENROUTER_COMPAT_FREE_ALIAS;
      const openrouterCompatRef = resolveConfiguredOpenRouterCompatAlias({
        cfg: params.cfg,
        agentId: params.agentId,
        raw: trimmed,
        defaultProvider: params.defaultProvider,
        allowManifestNormalization: params.allowManifestNormalization,
        allowPluginNormalization: params.allowPluginNormalization,
        manifestPlugins: needsOpenRouterCompatManifestPlugins
          ? manifestPluginContext.get()
          : manifestPlugins,
      });
      if (openrouterCompatRef) {
        return openrouterCompatRef;
      }

      let inferredProvider = inferUniqueProviderFromConfiguredModels({
        cfg: params.cfg,
        model: trimmed,
        agentId: params.agentId,
        allowManifestNormalization: false,
        manifestPlugins,
      });
      let inferredProviderManifestPlugins = manifestPlugins;
      if (
        (!inferredProvider || inferredProvider !== "openai") &&
        hasConfiguredRowsNeedingManifestLookup(params.cfg, params.defaultProvider, params.agentId)
      ) {
        // Non-default provider rows may normalize through plugin manifests. Avoid
        // that heavier lookup unless the cheap configured pass was ambiguous.
        inferredProviderManifestPlugins = manifestPluginContext.get();
        inferredProvider =
          inferUniqueProviderFromConfiguredModels({
            cfg: params.cfg,
            model: trimmed,
            agentId: params.agentId,
            allowManifestNormalization: params.allowManifestNormalization,
            manifestPlugins: inferredProviderManifestPlugins,
          }) ?? inferredProvider;
      }
      if (inferredProvider) {
        return normalizeModelRef(inferredProvider, trimmed, {
          allowManifestNormalization: inferredProviderManifestPlugins
            ? params.allowManifestNormalization
            : false,
          allowPluginNormalization: params.allowPluginNormalization,
          manifestPlugins: inferredProviderManifestPlugins,
        });
      }

      const safeTrimmed = sanitizeModelWarningValue(trimmed);
      const safeResolved = sanitizeForLog(`${params.defaultProvider}/${safeTrimmed}`);
      getLog().warn(
        `Model "${safeTrimmed}" specified without provider. Falling back to "${safeResolved}". Please use "${safeResolved}" in your config.`,
      );
      if (inferredProviderManifestPlugins === undefined) {
        return { provider: params.defaultProvider, model: trimmed };
      }
    }

    const resolved = resolveModelRefFromString({
      cfg: params.cfg,
      agentId: params.agentId,
      raw: trimmed,
      defaultProvider: params.defaultProvider,
      allowManifestNormalization: params.allowManifestNormalization,
      allowPluginNormalization: params.allowPluginNormalization,
      manifestPlugins: manifestPluginContext.get(),
    });
    if (resolved) {
      return resolved.ref;
    }

    const safe = sanitizeForLog(trimmed);
    const safeFallback = sanitizeForLog(`${params.defaultProvider}/${params.defaultModel}`);
    getLog().warn(
      `Model "${safe}" could not be resolved. Falling back to default "${safeFallback}".`,
    );
  }
  const fallbackProvider = resolveConfiguredProviderFallback({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
  });
  if (fallbackProvider) {
    return fallbackProvider;
  }
  return { provider: params.defaultProvider, model: params.defaultModel };
}

type ModelPolicyPreparationParams = BuildModelAliasIndexParams & {
  catalog: ModelCatalogEntry[];
  defaultModel?: string;
};

type AllowedModelSet = {
  allowAny: boolean;
  allowedCatalog: ModelCatalogEntry[];
  allowedKeys: Set<string>;
  allows: (ref: ModelRef) => boolean;
};

/** Build explicit model override authorization without widening it for automatic fallbacks. */
export function buildAllowedModelSet(
  params: {
    cfg: OpenClawConfig;
    catalog: ModelCatalogEntry[];
    defaultProvider: string;
    defaultModel?: string;
    agentId?: string;
  } & ModelManifestNormalizationContext,
): AllowedModelSet {
  return buildAllowedModelSetFromPrepared(params, prepareModelPolicy(params));
}

function prepareModelPolicy(params: ModelPolicyPreparationParams) {
  const visibility = parseConfiguredModelVisibilityEntries(params);
  const policyAliasAgentId = resolvePolicyAliasAgentId(visibility.configPath, params.agentId);
  const policyAliasIndex = buildModelAliasIndex({ ...params, agentId: policyAliasAgentId });
  // Inherited policy aliases keep their owner's scope; selection and display
  // aliases still honor the selected agent's overrides.
  const selectionAliasIndex =
    params.agentId && policyAliasAgentId !== params.agentId
      ? buildModelAliasIndex(params)
      : policyAliasIndex;
  const configuredCatalog = buildConfiguredModelCatalog({
    cfg: params.cfg,
    catalog: params.catalog,
    manifestPlugins: params.manifestPlugins,
  });
  const metadata = buildModelCatalogMetadata({
    configuredCatalog,
    aliasIndex: selectionAliasIndex,
  });
  const catalog = mergeModelCatalogEntries({
    primary: params.catalog,
    secondary: configuredCatalog,
  }).map((entry) => applyModelCatalogMetadata({ entry, metadata }));
  return {
    visibility,
    policyAliasIndex,
    selectionAliasIndex,
    configuredCatalog,
    metadata,
    catalog,
  };
}

function buildAllowedModelSetFromPrepared(
  params: ModelPolicyPreparationParams,
  { visibility, policyAliasIndex, metadata, catalog }: ReturnType<typeof prepareModelPolicy>,
): AllowedModelSet {
  const wildcardModelKeys = visibility.wildcardModelKeys;
  const allowAny = !visibility.hasEntries;
  const defaultModelNormalization = allowAny
    ? {
        allowManifestNormalization: false,
        allowPluginNormalization: false,
        manifestPlugins: params.manifestPlugins,
      }
    : {
        allowManifestNormalization: params.allowManifestNormalization,
        allowPluginNormalization: params.allowPluginNormalization,
        manifestPlugins: params.manifestPlugins,
      };
  const defaultModel = params.defaultModel?.trim();
  const defaultRef =
    defaultModel && params.defaultProvider
      ? parseModelRefWithCompatAlias({
          cfg: params.cfg,
          agentId: params.agentId,
          raw: defaultModel,
          defaultProvider: params.defaultProvider,
          ...defaultModelNormalization,
        })
      : null;
  const defaultKey = defaultRef ? modelKey(defaultRef.provider, defaultRef.model) : undefined;
  const resolvePolicyModelRef = (raw: string) => {
    const trimmed = raw.trim();
    const defaultProvider = !trimmed.includes("/")
      ? resolveBareModelDefaultProvider({
          cfg: params.cfg,
          catalog,
          model: trimmed,
          defaultProvider: params.defaultProvider,
          agentId: params.agentId,
          manifestPlugins: params.manifestPlugins,
        })
      : params.defaultProvider;
    return resolveModelRefFromString({
      cfg: params.cfg,
      agentId: params.agentId,
      raw,
      defaultProvider,
      aliasIndex: policyAliasIndex,
      allowManifestNormalization: params.allowManifestNormalization,
      allowPluginNormalization: params.allowPluginNormalization,
      manifestPlugins: params.manifestPlugins,
    })?.ref;
  };
  const allowAll = (): AllowedModelSet => {
    const allowedKeys = new Set(catalog.map((entry) => modelKey(entry.provider, entry.id)));
    if (defaultKey) {
      allowedKeys.add(defaultKey);
    }
    return { allowAny: true, allowedCatalog: catalog, allowedKeys, allows: () => true };
  };

  if (allowAny) {
    return allowAll();
  }

  const allowedKeys = new Set<string>();
  const catalogIdentities = new Set(catalog.map(resolveModelCatalogIdentityKey));
  const allowedCatalogIdentities = new Set<string>();
  const exactAllowedIdentities = new Set<string>();
  const allowedCaseInsensitiveIdentities = new Set<string>();
  const caseInsensitiveIdentity = (provider: string, model: string) =>
    JSON.stringify([normalizeProviderId(provider), normalizeLowercaseStringOrEmpty(model)]);
  const syntheticCatalogEntries = new Map<string, ModelCatalogEntry>();
  for (const wildcardKey of wildcardModelKeys) {
    allowedKeys.add(wildcardKey);
  }
  const addAllowedCatalogRef = (ref: ModelRef) => {
    const identity = resolveModelCatalogIdentityKey({ provider: ref.provider, id: ref.model });
    allowedCatalogIdentities.add(identity);
    allowedCaseInsensitiveIdentities.add(caseInsensitiveIdentity(ref.provider, ref.model));
    return modelCatalogEntryKey({ provider: ref.provider, id: ref.model });
  };
  for (const entry of expandModelCatalogWildcards(catalog, wildcardModelKeys)) {
    allowedKeys.add(modelKey(entry.provider, entry.id));
    addAllowedCatalogRef({ provider: entry.provider, model: entry.id });
  }
  const addAllowedModelRef = (raw: string) => {
    const parsed = resolvePolicyModelRef(raw);
    if (!parsed) {
      return;
    }
    const key = modelKey(parsed.provider, parsed.model);
    allowedKeys.add(key);
    exactAllowedIdentities.add(addAllowedCatalogRef(parsed));
    const syntheticKey = modelCatalogEntryKey({ provider: parsed.provider, id: parsed.model });

    if (
      !catalogIdentities.has(
        resolveModelCatalogIdentityKey({ provider: parsed.provider, id: parsed.model }),
      ) &&
      !findModelCatalogEntry(catalog, { provider: parsed.provider, modelId: parsed.model }) &&
      !syntheticCatalogEntries.has(syntheticKey)
    ) {
      // Config can allow a model before it appears in live provider catalogs.
      // Synthetic entries keep UI/model switchers aligned with that allowlist.
      const alias = metadata.aliasByKey.get(key);
      syntheticCatalogEntries.set(syntheticKey, {
        id: parsed.model,
        name: parsed.model,
        provider: parsed.provider,
        ...(alias ? { alias } : {}),
      });
    }
  };

  for (const raw of visibility.exactModelRefs) {
    addAllowedModelRef(raw);
  }

  if (
    defaultKey &&
    ((visibility.exactModelRefs.length > 0 && wildcardModelKeys.size === 0) ||
      isModelKeyAllowedBySet(wildcardModelKeys, defaultKey))
  ) {
    allowedKeys.add(defaultKey);
    if (defaultRef) {
      const identity = addAllowedCatalogRef(defaultRef);
      if (wildcardModelKeys.size === 0) {
        exactAllowedIdentities.add(identity);
      }
    }
  }

  const allowedCatalog = [
    ...catalog.filter(
      (entry) =>
        allowedCatalogIdentities.has(resolveModelCatalogIdentityKey(entry)) ||
        allowedCaseInsensitiveIdentities.has(caseInsensitiveIdentity(entry.provider, entry.id)),
    ),
    ...syntheticCatalogEntries.values(),
  ];

  if (allowedCatalog.length === 0 && allowedKeys.size === 0 && wildcardModelKeys.size === 0) {
    return allowAll();
  }

  return {
    allowAny: false,
    allowedCatalog,
    allowedKeys,
    allows: (ref) => {
      const provider = normalizeProviderId(ref.provider);
      return (
        exactAllowedIdentities.has(modelCatalogEntryKey({ provider, id: ref.model })) ||
        // Wildcard catalog expansion uses display keys; it cannot authorize resolved tuples.
        (visibility.providerWildcards.has(provider) &&
          isModelKeyAllowedBySet(wildcardModelKeys, `${provider}/${ref.model}`))
      );
    },
  };
}

/** Status of a candidate model against catalog and configured allowlist state. */
export type ModelRefStatus = {
  key: string;
  inCatalog: boolean;
  allowAny: boolean;
  allowed: boolean;
};

type ResolveAllowedModelRefResult =
  | { ref: ModelRef; key: string }
  | {
      error: string;
    };

export function getModelRefStatus(
  params: {
    cfg: OpenClawConfig;
    catalog: ModelCatalogEntry[];
    ref: ModelRef;
    defaultProvider: string;
    defaultModel?: string;
    agentId?: string;
  } & ModelManifestNormalizationContext,
): ModelRefStatus {
  const allowed = buildAllowedModelSet(params);
  const key = modelKey(params.ref.provider, params.ref.model);
  return {
    key,
    inCatalog: Boolean(
      findModelCatalogEntry(params.catalog, {
        provider: params.ref.provider,
        modelId: params.ref.model,
      }),
    ),
    allowAny: allowed.allowAny,
    allowed: allowed.allows(params.ref),
  };
}

/** Resolve a requested model string only if it is allowed by the supplied status check. */
export function resolveAllowedModelRefFromAliasIndex(
  params: {
    cfg: OpenClawConfig;
    raw: string;
    defaultProvider: string;
    agentId?: string;
    aliasIndex: ModelAliasIndex;
    getStatus: (ref: ModelRef) => ModelRefStatus;
  } & ModelManifestNormalizationContext,
): ResolveAllowedModelRefResult {
  const trimmed = params.raw.trim();
  if (!trimmed) {
    return { error: "invalid model: empty" };
  }

  const effectiveDefaultProvider = !trimmed.includes("/")
    ? (inferUniqueProviderFromConfiguredModels({
        cfg: params.cfg,
        model: trimmed,
        agentId: params.agentId,
        manifestPlugins: params.manifestPlugins,
      }) ?? params.defaultProvider)
    : params.defaultProvider;

  const resolved = resolveModelRefFromString({
    cfg: params.cfg,
    agentId: params.agentId,
    raw: trimmed,
    defaultProvider: effectiveDefaultProvider,
    aliasIndex: params.aliasIndex,
    manifestPlugins: params.manifestPlugins,
  });
  if (!resolved) {
    return { error: `invalid model: ${trimmed}` };
  }

  const status = params.getStatus(resolved.ref);
  if (!status.allowed) {
    return { error: `model not allowed: ${status.key}` };
  }

  return { ref: resolved.ref, key: status.key };
}

/** True when config contains provider model rows that should seed catalogs. */
function hasConfiguredProviderModelRows(cfg: OpenClawConfig): boolean {
  const providers = cfg.models?.providers;
  if (!providers || typeof providers !== "object") {
    return false;
  }
  return Object.values(providers).some((provider) => Array.isArray(provider?.models));
}

function hasConfiguredProviderRowsNeedingManifestLookup(cfg: OpenClawConfig): boolean {
  const providers = cfg.models?.providers;
  if (!providers || typeof providers !== "object") {
    return false;
  }
  return Object.entries(providers).some(
    ([providerRaw, provider]) =>
      Array.isArray(provider?.models) && normalizeProviderId(providerRaw) !== "openai",
  );
}

function hasConfiguredModelRefsNeedingManifestLookup(
  cfg: OpenClawConfig,
  defaultProvider: string,
  agentId?: string,
): boolean {
  const normalizedDefaultProvider = normalizeProviderId(defaultProvider);
  return listConfiguredModelMaps(cfg, agentId).some(({ models }) =>
    Object.keys(models ?? {}).some((keyRaw) => {
      const key = keyRaw.trim();
      if (!key || key.endsWith("/*")) {
        return false;
      }
      const slashIndex = key.indexOf("/");
      if (slashIndex <= 0) {
        return false;
      }
      const provider = normalizeProviderId(key.slice(0, slashIndex));
      return Boolean(provider && provider !== normalizedDefaultProvider);
    }),
  );
}

function hasConfiguredRowsNeedingManifestLookup(
  cfg: OpenClawConfig,
  defaultProvider: string,
  agentId?: string,
): boolean {
  return (
    hasConfiguredProviderRowsNeedingManifestLookup(cfg) ||
    hasConfiguredModelRefsNeedingManifestLookup(cfg, defaultProvider, agentId)
  );
}

function resolveConfiguredModelManifestPlugins(params: {
  cfg: OpenClawConfig;
  workspaceDir?: string;
  manifestPlugins?: ModelManifestPlugins;
}): ModelManifestPlugins {
  if (params.manifestPlugins) {
    return params.manifestPlugins;
  }
  if (!hasConfiguredProviderModelRows(params.cfg)) {
    return undefined;
  }
  const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState();
  if (!workspaceDir) {
    return getCurrentPluginMetadataSnapshot({
      config: params.cfg,
      env: process.env,
    });
  }
  return loadManifestMetadataSnapshot({
    config: params.cfg,
    env: process.env,
    ...(workspaceDir ? { workspaceDir } : {}),
  });
}

/** Build catalog entries from configured provider model rows. */
export function buildConfiguredModelCatalog(params: {
  cfg: OpenClawConfig;
  catalog?: readonly ModelCatalogEntry[];
  workspaceDir?: string;
  manifestPlugins?: ModelManifestPlugins;
}): ModelCatalogEntry[] {
  const providers = params.cfg.models?.providers;
  if (!providers || typeof providers !== "object") {
    return [];
  }

  const manifestPlugins = resolveConfiguredModelManifestPlugins(params);
  const normalizeModelId = createConfiguredProviderCatalogModelIdNormalizer({ manifestPlugins });
  const capturedByIdentity = params.catalog?.length
    ? indexFirstByKey(params.catalog, resolveModelCatalogIdentityKey)
    : undefined;
  const catalog: ModelCatalogEntry[] = [];
  for (const [providerRaw, provider] of Object.entries(providers)) {
    const providerId = normalizeProviderId(providerRaw);
    if (!providerId || !Array.isArray(provider?.models)) {
      continue;
    }
    for (const model of provider.models) {
      const rawId = normalizeOptionalString(model?.id) ?? "";
      const id = rawId ? normalizeModelId(providerId, rawId) : "";
      if (!id) {
        continue;
      }
      // Provider defaults are fallbacks; only a model-level pin overrides its captured route.
      const accepted = capturedByIdentity?.get(
        resolveModelCatalogIdentityKey({ provider: providerId, id }),
      );
      const api = model.api ?? accepted?.api ?? provider.api;
      const baseUrl = model.baseUrl ?? accepted?.baseUrl ?? provider.baseUrl;
      const name = normalizeOptionalString(model?.name) || id;
      const contextWindow =
        typeof model?.contextWindow === "number" && model.contextWindow > 0
          ? model.contextWindow
          : undefined;
      const contextTokens =
        typeof model?.contextTokens === "number" && model.contextTokens > 0
          ? model.contextTokens
          : undefined;
      const input = Array.isArray(model?.input) ? model.input : undefined;
      const modelParams =
        model?.params && typeof model.params === "object" ? model.params : undefined;
      const compat = model?.compat && typeof model.compat === "object" ? model.compat : undefined;
      const reasoning =
        typeof model?.reasoning === "boolean"
          ? model.reasoning
          : isVllmQwenThinkingCompat(providerId, compat)
            ? true
            : undefined;
      catalog.push({
        provider: providerId,
        id,
        name,
        api,
        ...(baseUrl ? { baseUrl } : {}),
        contextWindow,
        contextTokens,
        reasoning,
        ...(typeof model?.reasoning === "boolean" ? { configuredReasoning: model.reasoning } : {}),
        ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
        input,
        ...(modelParams ? { params: modelParams } : {}),
        compat,
      });
    }
  }

  return catalog;
}

function isVllmQwenThinkingCompat(
  providerId: string,
  compat?: { thinkingFormat?: unknown } | null,
): boolean {
  return (
    providerId === "vllm" &&
    (compat?.thinkingFormat === "qwen" || compat?.thinkingFormat === "qwen-chat-template")
  );
}

export function resolveHooksGmailModel(
  params: {
    cfg: OpenClawConfig;
    defaultProvider: string;
  } & ModelManifestNormalizationContext,
): ModelRef | null {
  const hooksModel = params.cfg.hooks?.gmail?.model;
  if (!hooksModel?.trim()) {
    return null;
  }

  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
    manifestPlugins: params.manifestPlugins,
  });

  const resolved = resolveModelRefFromString({
    cfg: params.cfg,
    raw: hooksModel,
    defaultProvider: params.defaultProvider,
    aliasIndex,
    manifestPlugins: params.manifestPlugins,
  });

  return resolved?.ref ?? null;
}

const DEFAULT_MODEL_POLICY_ALLOW_CONFIG_PATH = "agents.defaults.modelPolicy.allow";
const AGENT_MODEL_POLICY_ALLOW_CONFIG_PATH = "agents.entries.*.modelPolicy.allow";
export const LEGACY_MODEL_POLICY_ALLOW_CONFIG_PATH = "agents.defaults.models";

function resolvePolicyAliasAgentId(
  configPath: string | null,
  agentId: string | undefined,
): string | undefined {
  return configPath === AGENT_MODEL_POLICY_ALLOW_CONFIG_PATH ? agentId : undefined;
}

export function resolveConfiguredModelPolicyAllow(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
}): { refs: readonly string[]; configPath: string | null; repairConfigPath: string } {
  const defaults = params.cfg?.agents?.defaults;
  if (params.agentId) {
    const agent = params.cfg ? resolveAgentConfig(params.cfg, params.agentId) : undefined;
    const agentPolicy = agent?.modelPolicy;
    if (hasExplicitModelPolicyAllow(agentPolicy)) {
      return {
        refs: agentPolicy?.allow ?? [],
        configPath: AGENT_MODEL_POLICY_ALLOW_CONFIG_PATH,
        repairConfigPath: AGENT_MODEL_POLICY_ALLOW_CONFIG_PATH,
      };
    }
  }
  const defaultPolicy = defaults?.modelPolicy;
  if (hasExplicitModelPolicyAllow(defaultPolicy)) {
    return {
      refs: defaultPolicy?.allow ?? [],
      configPath: DEFAULT_MODEL_POLICY_ALLOW_CONFIG_PATH,
      repairConfigPath: DEFAULT_MODEL_POLICY_ALLOW_CONFIG_PATH,
    };
  }
  const legacyDefaultRefs = computeModelPolicyAllowlist({
    root: params.cfg,
    defaults,
  });
  if (legacyDefaultRefs) {
    return {
      refs: legacyDefaultRefs,
      configPath: LEGACY_MODEL_POLICY_ALLOW_CONFIG_PATH,
      repairConfigPath: DEFAULT_MODEL_POLICY_ALLOW_CONFIG_PATH,
    };
  }
  return { refs: [], configPath: null, repairConfigPath: DEFAULT_MODEL_POLICY_ALLOW_CONFIG_PATH };
}

export function parseConfiguredModelVisibilityEntries(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
}): {
  exactModelRefs: string[];
  providerWildcards: Set<string>;
  wildcardModelKeys: Set<string>;
  hasEntries: boolean;
  configPath: string | null;
  repairConfigPath: string;
} {
  const configured = resolveConfiguredModelPolicyAllow(params);
  const exactModelRefs: string[] = [];
  const providerWildcards = new Set<string>();
  const wildcardModelKeys = new Set<string>();

  for (const raw of configured.refs) {
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    const wildcard = parseModelPolicyWildcardRef(trimmed);
    if (wildcard) {
      providerWildcards.add(wildcard.provider);
      wildcardModelKeys.add(wildcard.key);
      continue;
    }
    exactModelRefs.push(raw);
  }

  return {
    exactModelRefs,
    providerWildcards,
    wildcardModelKeys,
    hasEntries: configured.refs.length > 0,
    configPath: configured.configPath,
    repairConfigPath: configured.repairConfigPath,
  };
}

/** Expand segment-boundary prefix wildcard policy entries against discovered catalog rows. */
function expandModelCatalogWildcards<T extends { provider: string; id: string }>(
  catalog: readonly T[],
  wildcardModelKeys: ReadonlySet<string>,
): T[] {
  return catalog.filter((entry) =>
    isModelKeyAllowedBySet(wildcardModelKeys, modelKey(entry.provider, entry.id)),
  );
}

export function isModelKeyAllowedBySet(allowedKeys: ReadonlySet<string>, key: string): boolean {
  if (allowedKeys.has(key)) {
    return true;
  }
  let separator = key.indexOf("/");
  while (separator > 0) {
    if (allowedKeys.has(`${key.slice(0, separator + 1)}*`)) {
      return true;
    }
    separator = key.indexOf("/", separator + 1);
  }
  return false;
}

function resolveAllowedModelSelection(
  params: {
    cfg?: OpenClawConfig;
    provider: string;
    model: string;
    allows: (ref: ModelRef) => boolean;
    allowedCatalog: readonly ModelCatalogEntry[];
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): ModelRef | null {
  const current =
    resolveExactConfiguredProviderRef({
      cfg: params.cfg,
      raw: `${params.provider}/${params.model}`,
      allowManifestNormalization: params.allowManifestNormalization,
      manifestPlugins: params.manifestPlugins,
    }) ??
    normalizeModelRef(params.provider, params.model, {
      allowManifestNormalization: params.allowManifestNormalization,
      allowPluginNormalization: params.allowPluginNormalization,
      manifestPlugins: params.manifestPlugins,
    });
  if (params.allows(current)) {
    return current;
  }
  const fallback = params.allowedCatalog.find((entry) =>
    params.allows({ provider: entry.provider, model: entry.id }),
  );
  return fallback ? { provider: fallback.provider, model: fallback.id } : null;
}

export type ModelVisibilityPolicy = {
  allowAny: boolean;
  configuredCatalog: readonly ModelCatalogEntry[];
  allowedCatalog: ModelCatalogEntry[];
  allowedKeys: Set<string>;
  policyAliasIndex: ModelAliasIndex;
  selectionAliasIndex: ModelAliasIndex;
  configuredKeys: ReadonlySet<string>;
  retainedKeys: ReadonlySet<string>;
  exactModelRefs: readonly string[];
  providerWildcards: ReadonlySet<string>;
  hasConfiguredEntries: boolean;
  hasProviderWildcards: boolean;
  allowConfigPath?: string | null;
  allowRepairConfigPath: string;
  allows: (ref: { provider: string; model: string }) => boolean;
  allowsByWildcard: (ref: { provider: string; model: string }) => boolean;
  resolveSelection: (ref: { provider: string; model: string }) => ModelRef | null;
  visibleCatalog: (params: {
    catalog: readonly ModelCatalogEntry[];
    defaultVisibleCatalog: readonly ModelCatalogEntry[];
    view?: "default" | "configured" | "all";
  }) => ModelCatalogEntry[];
};

export function dedupeModelCatalogEntries(
  entries: readonly ModelCatalogEntry[],
): ModelCatalogEntry[] {
  // Preserve the first occurrence after precedence merging while removing
  // provider/id duplicates from configured and auth-backed catalogs.
  return dedupeByKey(entries, modelCatalogEntryKey);
}

export function createModelVisibilityPolicyWithFallbacks(
  params: {
    cfg: OpenClawConfig;
    catalog: ModelCatalogEntry[];
    defaultProvider: string;
    defaultModel?: string;
    fallbackModels: readonly string[];
    additionalConfiguredModelRefs?: readonly string[];
    agentId?: string;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): ModelVisibilityPolicy {
  const prepared = prepareModelPolicy(params);
  const { visibility, policyAliasIndex, selectionAliasIndex, configuredCatalog } = prepared;
  const wildcardModelKeys = visibility.wildcardModelKeys;
  const allowed = buildAllowedModelSetFromPrepared(params, prepared);
  const configuredKeys = new Set(configuredCatalog.map(resolveModelCatalogIdentityKey));
  const retainedKeys = new Set<string>();
  const addConfiguredRef = (
    raw: string | undefined,
    retained: boolean,
    aliasIndex: ModelAliasIndex,
    knownProvider?: string,
  ): ModelRef | undefined => {
    if (!raw?.trim() || parseModelPolicyWildcardRef(raw)) {
      return undefined;
    }
    const defaultProvider =
      knownProvider ??
      (!raw.includes("/")
        ? resolveBareModelDefaultProvider({ ...params, model: raw.trim() })
        : params.defaultProvider);
    const resolved = resolveModelRefFromString({
      cfg: params.cfg,
      agentId: params.agentId,
      raw,
      defaultProvider,
      aliasIndex,
      allowManifestNormalization: params.allowManifestNormalization,
      allowPluginNormalization: params.allowPluginNormalization,
      manifestPlugins: params.manifestPlugins,
    });
    if (!resolved) {
      return undefined;
    }
    const key = resolveModelCatalogIdentityKey({
      provider: resolved.ref.provider,
      id: resolved.ref.model,
    });
    configuredKeys.add(key);
    if (retained) {
      retainedKeys.add(key);
    }
    return resolved.ref;
  };
  const exactConfiguredKeys = new Set<string>();
  for (const raw of visibility.exactModelRefs) {
    const resolved = addConfiguredRef(raw, false, policyAliasIndex);
    if (resolved) {
      exactConfiguredKeys.add(modelKey(resolved.provider, resolved.model));
    }
  }
  for (const raw of params.additionalConfiguredModelRefs ?? []) {
    addConfiguredRef(raw, false, selectionAliasIndex);
  }
  addConfiguredRef(params.defaultModel, true, selectionAliasIndex, params.defaultProvider);
  for (const fallback of params.fallbackModels) {
    // Configured fallbacks remain available for automatic failover and catalog
    // retention, but are not user-selectable overrides unless policy also allows them.
    addConfiguredRef(fallback, true, selectionAliasIndex);
  }
  const policy: ModelVisibilityPolicy = {
    allowAny: allowed.allowAny,
    configuredCatalog,
    allowedCatalog: allowed.allowedCatalog,
    allowedKeys: allowed.allowedKeys,
    policyAliasIndex,
    selectionAliasIndex,
    configuredKeys,
    retainedKeys,
    exactModelRefs: visibility.exactModelRefs,
    providerWildcards: visibility.providerWildcards,
    hasConfiguredEntries: visibility.hasEntries,
    hasProviderWildcards: wildcardModelKeys.size > 0,
    allowConfigPath: visibility.configPath,
    allowRepairConfigPath: visibility.repairConfigPath,
    allows: allowed.allows,
    allowsByWildcard: (ref) => {
      const provider = normalizeProviderId(ref.provider);
      return (
        visibility.providerWildcards.has(provider) &&
        isModelKeyAllowedBySet(wildcardModelKeys, `${provider}/${ref.model}`)
      );
    },
    resolveSelection: (ref) =>
      resolveAllowedModelSelection({
        provider: ref.provider,
        model: ref.model,
        cfg: params.cfg,
        allows: allowed.allows,
        allowedCatalog: allowed.allowedCatalog,
        allowManifestNormalization: params.allowManifestNormalization,
        allowPluginNormalization: params.allowPluginNormalization,
        manifestPlugins: params.manifestPlugins,
      }),
    visibleCatalog: ({ catalog, defaultVisibleCatalog, view }) => {
      if (view === "all") {
        return [...catalog];
      }
      if (allowed.allowAny) {
        return [...defaultVisibleCatalog];
      }
      if (wildcardModelKeys.size === 0) {
        return [...allowed.allowedCatalog];
      }
      return dedupeModelCatalogEntries([
        ...defaultVisibleCatalog.filter((entry) =>
          isModelKeyAllowedBySet(wildcardModelKeys, modelKey(entry.provider, entry.id)),
        ),
        ...allowed.allowedCatalog.filter((entry) =>
          exactConfiguredKeys.has(modelKey(entry.provider, entry.id)),
        ),
      ]);
    },
  };
  return policy;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
