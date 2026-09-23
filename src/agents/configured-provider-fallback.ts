/**
 * Chooses a configured provider/model fallback when defaults are absent from
 * the user's model config.
 */
import {
  findNormalizedProviderValue,
  normalizeProviderId,
} from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.js";

type ProviderModelRef = {
  provider: string;
  model: string;
};

/** Resolve the first configured provider/model that can replace a missing default. */
export function resolveConfiguredProviderFallback(params: {
  cfg: Pick<OpenClawConfig, "models">;
  defaultProvider: string;
  defaultModel: string | undefined;
  excludedModel?: ProviderModelRef;
}): ProviderModelRef | null {
  const configuredProviders = params.cfg.models?.providers;
  if (!configuredProviders || typeof configuredProviders !== "object") {
    return null;
  }
  const defaultProviderConfig = findNormalizedProviderValue(
    configuredProviders,
    params.defaultProvider,
  );
  const defaultModel = params.defaultModel?.trim();
  const defaultProviderHasConfiguredModel =
    Array.isArray(defaultProviderConfig?.models) &&
    defaultProviderConfig.models.some((model) => Boolean(model?.id));
  const defaultProviderHasDefaultModel =
    defaultModel !== undefined &&
    Array.isArray(defaultProviderConfig?.models) &&
    defaultProviderConfig.models.some((model) => model?.id === defaultModel);
  if (defaultProviderHasConfiguredModel && (!defaultModel || defaultProviderHasDefaultModel)) {
    return null;
  }
  // A utility-only row does not express primary intent. Keep the remaining
  // provider/model insertion order as the operator's fallback preference.
  for (const [provider, providerCfg] of Object.entries(configuredProviders)) {
    const models = providerCfg?.models;
    if (!Array.isArray(models) || !models[0]?.id) {
      continue;
    }
    const normalizedProvider = normalizeProviderId(provider);
    const model = models.find(
      (entry) =>
        entry?.id &&
        (normalizedProvider !== params.excludedModel?.provider ||
          entry.id !== params.excludedModel.model),
    );
    if (model) {
      return { provider: normalizedProvider, model: model.id };
    }
  }
  return null;
}
