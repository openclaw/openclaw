import type { OpenClawConfig } from "../config/types.openclaw.js";
import { DEFAULT_PROVIDER } from "./defaults.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";
import type { ModelManifestNormalizationContext, ModelRefSelection } from "./model-ref-shared.js";
import {
  buildModelAliasIndex,
  inferUniqueProviderFromConfiguredModels,
  listModelAliasCandidates,
} from "./model-selection-shared.js";

/**
 * Resolve the effective compaction target from config, falling back to the
 * caller-supplied provider/model and retaining its normalization status.
 */
export function resolveCompactionModelSelection(params: {
  config?: OpenClawConfig;
  provider?: string | null;
  modelId?: string | null;
  modelSelectionLocked?: boolean;
  defaultProvider?: string;
  defaultModel?: string;
  allowPluginNormalization?: boolean;
  manifestPlugins?: ModelManifestNormalizationContext["manifestPlugins"];
}): {
  provider: string | undefined;
  model: string | undefined;
  normalization: ModelRefSelection["normalization"];
} {
  const provider = params.provider?.trim() || params.defaultProvider;
  const model = params.modelId?.trim() || params.defaultModel;
  // A locked session's creating model owns every transcript read, including
  // summaries. Compaction-specific model overrides would cross that boundary.
  const override = params.modelSelectionLocked
    ? undefined
    : params.config?.agents?.defaults?.compaction?.model?.trim();
  const assembleTarget = (
    targetProvider: string | undefined,
    targetModel: string | undefined,
    normalization: ModelRefSelection["normalization"] = "pending",
  ) => {
    return { provider: targetProvider, model: targetModel, normalization };
  };
  if (!override) {
    return assembleTarget(provider, model);
  }
  const slashIdx = override.indexOf("/");
  if (slashIdx > 0) {
    const overrideProvider = override.slice(0, slashIdx).trim();
    const overrideModel = override.slice(slashIdx + 1).trim() || params.defaultModel;
    return assembleTarget(overrideProvider, overrideModel);
  }
  const config = params.config ?? {};
  const currentProvider = provider?.trim();
  if (
    currentProvider &&
    hasBareConfiguredModelForProvider({
      cfg: config,
      provider: currentProvider,
      model: override,
    })
  ) {
    return assembleTarget(currentProvider, override);
  }
  const inferredLiteralProvider = inferUniqueProviderFromConfiguredModels({
    cfg: config,
    model: override,
    allowManifestNormalization: false,
  });
  if (inferredLiteralProvider) {
    return assembleTarget(inferredLiteralProvider, override);
  }
  const defaultProvider = provider || DEFAULT_PROVIDER;
  const aliasKey = normalizeCompactionConfigKey(splitTrailingAuthProfile(override).model);
  // Unrelated aliases must not cold-load provider runtime for a literal override.
  const alias = listModelAliasCandidates(config).some(
    ({ alias: candidate }) => normalizeCompactionConfigKey(candidate) === aliasKey,
  )
    ? buildModelAliasIndex({
        cfg: config,
        defaultProvider,
        allowPluginNormalization: params.allowPluginNormalization,
        manifestPlugins: params.manifestPlugins,
      }).byAlias.get(aliasKey)
    : undefined;
  if (alias) {
    return assembleTarget(alias.ref.provider, alias.ref.model, "applied");
  }
  return assembleTarget(provider, override);
}

function normalizeCompactionConfigKey(value: string): string {
  return value.trim().toLowerCase();
}

function hasBareConfiguredModelForProvider(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
}): boolean {
  const providerKey = normalizeCompactionConfigKey(params.provider);
  const modelKey = normalizeCompactionConfigKey(params.model);
  if (!providerKey || !modelKey || params.model.includes("/")) {
    return false;
  }
  for (const rawRef of Object.keys(params.cfg.agents?.defaults?.models ?? {})) {
    const slashIdx = rawRef.indexOf("/");
    if (slashIdx <= 0 || rawRef.endsWith("/*")) {
      continue;
    }
    const rawProvider = rawRef.slice(0, slashIdx);
    const rawModel = rawRef.slice(slashIdx + 1);
    if (
      normalizeCompactionConfigKey(rawProvider) === providerKey &&
      normalizeCompactionConfigKey(rawModel) === modelKey
    ) {
      return true;
    }
  }
  const configuredProvider = Object.entries(params.cfg.models?.providers ?? {}).find(([key]) => {
    return normalizeCompactionConfigKey(key) === providerKey;
  })?.[1];
  return (configuredProvider?.models ?? []).some((entry) => {
    return normalizeCompactionConfigKey(entry?.id ?? "") === modelKey;
  });
}
