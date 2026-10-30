/** Projects effective configured model refs, aliases, and role tags for one agent. */
import { collectConfiguredModelRefs } from "@openclaw/model-catalog-core/configured-model-refs";
import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listAgentEntriesWithSource, resolveAgentConfig } from "./agent-scope-config.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import { type ModelManifestNormalizationContext, modelKey } from "./model-ref-shared.js";
import { resolveConfiguredModelFallbacks } from "./model-selection-resolve.js";
import {
  buildModelAliasIndex,
  inferUniqueProviderFromConfiguredModels,
  type ModelAliasIndex,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "./model-selection-shared.js";

type ConfiguredModelEntry = {
  key: string;
  ref: { provider: string; model: string };
  tags: Set<string>;
  aliases: string[];
  aliasDisabled: boolean;
  pickerRuntimes?: string[];
};

/** Resolve authored refs once at discovery; providers own server membership and aliases. */
export function collectConfiguredCatalogModels(cfg: OpenClawConfig) {
  const models = new Map<string, { provider: string; modelId: string; baseUrl?: string }>();
  for (const [providerId, providerConfig] of Object.entries(cfg.models?.providers ?? {})) {
    const provider = normalizeProviderId(providerId);
    for (const model of providerConfig.models ?? []) {
      models.set(modelKey(provider, model.id), {
        provider,
        modelId: model.id,
        baseUrl: model.baseUrl ?? providerConfig.baseUrl,
      });
    }
  }
  const agents = listAgentEntriesWithSource(cfg).map(({ entry, source }) => ({
    agentId: entry.id,
    prefix:
      source.kind === "entries" ? `agents.entries.${source.key}.` : `agents.list.${source.index}.`,
  }));
  const aliases = new Map<string | undefined, ModelAliasIndex>();
  for (const { path, value, kind } of collectConfiguredModelRefs(cfg)) {
    if (value.endsWith("/*")) {
      continue;
    }
    const agentId = agents.find(({ prefix }) => path.startsWith(prefix))?.agentId;
    const params = {
      cfg,
      agentId,
      defaultProvider: DEFAULT_PROVIDER,
      allowManifestNormalization: false,
      allowPluginNormalization: false,
    };
    let aliasIndex = aliases.get(agentId);
    if (!aliasIndex) {
      aliasIndex = buildModelAliasIndex(params);
      aliases.set(agentId, aliasIndex);
    }
    const literal = kind === "literal" ? parseModelCatalogRef(value) : null;
    const ref = literal
      ? { provider: literal.provider, model: literal.modelId }
      : resolveModelRefFromString({
          ...params,
          raw: value,
          defaultProvider:
            inferUniqueProviderFromConfiguredModels({ ...params, model: value }) ??
            DEFAULT_PROVIDER,
          ...(kind === "selector" ? { aliasIndex } : {}),
        })?.ref;
    if (ref && !models.has(modelKey(ref.provider, ref.model))) {
      models.set(modelKey(ref.provider, ref.model), {
        provider: ref.provider,
        modelId: ref.model,
        baseUrl: cfg.models?.providers?.[ref.provider]?.baseUrl,
      });
    }
  }
  return [...models.values()];
}

export function resolveConfiguredModelEntries(
  params: {
    cfg: OpenClawConfig;
    agentId?: string;
    defaultProvider?: string;
    defaultModel?: string;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
    canonicalizeRef?: <TRef extends { provider: string; model: string }>(ref: TRef) => TRef;
    aliasIndex?: ModelAliasIndex;
  } & ModelManifestNormalizationContext,
): {
  entries: ConfiguredModelEntry[];
  byKey: Map<string, ConfiguredModelEntry>;
  defaultRef: { provider: string; model: string };
} {
  const defaultProvider = params.defaultProvider ?? DEFAULT_PROVIDER;
  const defaultModel = params.defaultModel ?? DEFAULT_MODEL;
  const resolvedDefault = resolveConfiguredModelRef({
    ...params,
    defaultProvider,
    defaultModel,
  });
  const aliasIndex =
    params.aliasIndex ??
    buildModelAliasIndex({
      ...params,
      defaultProvider,
    });
  const entriesByKey = new Map<string, ConfiguredModelEntry>();

  const addEntry = (ref: { provider: string; model: string }, tag: string) => {
    const canonicalRef = params.canonicalizeRef?.(ref) ?? ref;
    const key = modelKey(canonicalRef.provider, canonicalRef.model);
    const originalKey = modelKey(ref.provider, ref.model);
    const entry: ConfiguredModelEntry = entriesByKey.get(key) ?? {
      key,
      ref: canonicalRef,
      tags: new Set<string>(),
      aliases: [],
      aliasDisabled: false,
    };
    entry.tags.add(tag);
    entry.aliases = [
      ...new Set([
        ...entry.aliases,
        ...(aliasIndex.byKey.get(key) ?? []),
        ...(originalKey === key ? [] : (aliasIndex.byKey.get(originalKey) ?? [])),
      ]),
    ];
    entry.aliasDisabled =
      entry.aliasDisabled ||
      aliasIndex.disabledKeys?.has(key) === true ||
      aliasIndex.disabledKeys?.has(originalKey) === true;
    entriesByKey.set(key, entry);
    return entry;
  };

  const addRaw = (raw: string, tag: string) => {
    const trimmed = raw.trim();
    const inferredProvider = trimmed.includes("/")
      ? undefined
      : inferUniqueProviderFromConfiguredModels({
          cfg: params.cfg,
          agentId: params.agentId,
          model: trimmed,
          allowManifestNormalization: params.allowManifestNormalization,
          manifestPlugins: params.manifestPlugins,
        });
    const resolved = resolveModelRefFromString({
      ...params,
      raw,
      defaultProvider: inferredProvider ?? defaultProvider,
      aliasIndex,
    });
    return resolved ? addEntry(resolved.ref, tag) : undefined;
  };

  addEntry(resolvedDefault, "default");
  resolveConfiguredModelFallbacks({ cfg: params.cfg, agentId: params.agentId }).forEach(
    (raw, index) => addRaw(raw, `fallback#${index + 1}`),
  );

  // Image-model configuration remains global; per-agent image inheritance is
  // outside this projection's model-metadata contract.
  const imageModel = params.cfg.agents?.defaults?.imageModel;
  const imagePrimary = resolveAgentModelPrimaryValue(imageModel);
  if (imagePrimary) {
    addRaw(imagePrimary, "image");
  }
  resolveAgentModelFallbackValues(imageModel).forEach((raw, index) =>
    addRaw(raw, `img-fallback#${index + 1}`),
  );

  const agentModels = params.agentId
    ? resolveAgentConfig(params.cfg, params.agentId)?.models
    : undefined;
  const configuredRefs = new Map<string, string[] | undefined>();
  for (const models of [params.cfg.agents?.defaults?.models, agentModels]) {
    for (const [raw, settings] of Object.entries(models ?? {})) {
      if (!raw.trim().endsWith("/*")) {
        configuredRefs.set(raw, settings.pickerRuntimes ?? configuredRefs.get(raw));
      }
    }
  }
  for (const [raw, pickerRuntimes] of configuredRefs) {
    const entry = addRaw(raw, "configured");
    if (entry && pickerRuntimes !== undefined) {
      entry.pickerRuntimes = [...new Set(pickerRuntimes)];
    }
  }

  return {
    defaultRef: resolvedDefault,
    entries: [...entriesByKey.values()],
    byKey: entriesByKey,
  };
}
