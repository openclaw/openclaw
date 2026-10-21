import { resolveMergedModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import {
  applyProviderConfigWithModelCatalogPreset,
  type ModelDefinitionConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { BIFROST_BASE_URL, normalizeBifrostBaseUrl } from "./defaults.js";

export function buildBifrostConnectionConfig(
  config: OpenClawConfig,
  baseUrl: string,
  anonymous: boolean,
): OpenClawConfig {
  const existing = resolveMergedModelProviderConfig(config, "bifrost");
  const sameEndpoint = existing && normalizeBifrostBaseUrl(existing.baseUrl) === baseUrl;
  // Keep deletion instructions intact until the host applies the returned auth patch.
  return {
    ...config,
    models: {
      ...config.models,
      providers: {
        ...config.models?.providers,
        bifrost: {
          ...existing,
          baseUrl,
          api: "openai-completions",
          models: existing?.models ?? [],
          auth: anonymous ? "none" : undefined,
          apiKey: undefined,
          authHeader: undefined,
          // Setup replaces authentication. Old header credentials must not override
          // the new key or follow anonymous discovery to another endpoint.
          headers: undefined,
          request: sameEndpoint
            ? { ...existing.request, auth: undefined, headers: undefined }
            : undefined,
        },
      },
    },
  };
}

export function applyBifrostModelConfig(config: OpenClawConfig, model: ModelDefinitionConfig) {
  return applyProviderConfigWithModelCatalogPreset(config, {
    providerId: "bifrost",
    baseUrl: config.models?.providers?.bifrost?.baseUrl ?? BIFROST_BASE_URL,
    api: "openai-completions",
    catalogModels: [model],
    aliases: [{ modelRef: `bifrost/${model.id}`, alias: "Bifrost" }],
  });
}
