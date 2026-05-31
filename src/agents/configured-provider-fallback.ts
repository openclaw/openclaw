import type { OpenClawConfig } from "../config/types.js";

type ProviderModelRef = {
  provider: string;
  model: string;
};

export function resolveConfiguredProviderFallback(params: {
  cfg: Pick<OpenClawConfig, "models">;
  defaultProvider: string;
  defaultModel?: string;
}): ProviderModelRef | null {
  const configuredProviders = params.cfg.models?.providers;
  if (!configuredProviders || typeof configuredProviders !== "object") {
    return null;
  }
  const defaultProviderConfig = configuredProviders[params.defaultProvider];
  const defaultModel = params.defaultModel?.trim();

  // If the default provider is configured and either has no model requirement
  // or already has the requested model, no fallback is needed.
  const defaultProviderHasDefaultModel =
    Boolean(defaultProviderConfig) &&
    Boolean(defaultModel) &&
    Array.isArray(defaultProviderConfig.models) &&
    defaultProviderConfig.models.some((model) => model?.id === defaultModel);
  if (defaultProviderConfig && (!defaultModel || defaultProviderHasDefaultModel)) {
    return null;
  }

  // If a specific model was requested, try to find a configured provider that
  // carries that exact model. This preserves the user's model choice and only
  // switches the provider — which is the correct behavior when the default
  // provider doesn't carry the model but another provider does.
  // Previously, the function would replace BOTH provider and model with the
  // first available provider's first model, producing incorrect refs like
  // "ollama/kimi-k2.6:cloud" when the user specified "openai/gpt-5.5".
  if (defaultModel) {
    const providerWithModel = Object.entries(configuredProviders).find(
      ([, providerCfg]) =>
        providerCfg &&
        Array.isArray(providerCfg.models) &&
        providerCfg.models.some((model) => model?.id === defaultModel),
    );
    if (providerWithModel) {
      return { provider: providerWithModel[0], model: defaultModel };
    }
  }

  // If the default provider is NOT configured at all (e.g., "openai" when only
  // "openai-codex" exists), return null so the caller preserves the explicitly-
  // specified provider/model pair rather than silently replacing it with an
  // unrelated provider's first model.
  if (!defaultProviderConfig) {
    return null;
  }

  // The default provider exists but doesn't have the requested model, and no
  // other provider has it either. Fall back to the first provider that has
  // any models configured.
  const availableProvider = Object.entries(configuredProviders).find(
    ([, providerCfg]) =>
      providerCfg &&
      Array.isArray(providerCfg.models) &&
      providerCfg.models.length > 0 &&
      providerCfg.models[0]?.id,
  );
  if (!availableProvider) {
    return null;
  }
  const [provider, providerCfg] = availableProvider;
  const models = providerCfg.models;
  if (!Array.isArray(models) || !models[0]?.id) {
    return null;
  }
  return { provider, model: models[0].id };
}
