import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import { resolveLmstudioProviderAuthMode } from "./provider-auth.js";

export function buildLmstudioSetupProviderConfig(params: {
  existingProvider: ModelProviderConfig | undefined;
  sharedProvider?: ModelProviderConfig;
  baseUrl: string;
  apiKey?: ModelProviderConfig["apiKey"];
  headers: ModelProviderConfig["headers"] | undefined;
  models: ModelDefinitionConfig[];
}): ModelProviderConfig {
  const {
    auth: _auth,
    apiKey: _apiKey,
    ...provider
  } = {
    ...params.existingProvider,
    ...params.sharedProvider,
  };
  const resolvedAuth = resolveLmstudioProviderAuthMode(params.apiKey);
  return {
    ...provider,
    baseUrl: params.baseUrl,
    api: params.sharedProvider?.api ?? params.existingProvider?.api ?? "openai-completions",
    ...(resolvedAuth ? { auth: resolvedAuth } : {}),
    ...(params.apiKey !== undefined ? { apiKey: params.apiKey } : {}),
    headers: params.headers,
    models: params.models.map((model) => {
      // Discovery caps are synthesized. Saved model limits override provider defaults,
      // and only the provider default must fit the final selected/served context.
      const modelMaxTokens = params.existingProvider?.models?.find(
        (entry) => entry.id === model.id,
      )?.maxTokens;
      const providerMaxTokens = params.existingProvider?.maxTokens;
      return {
        ...model,
        maxTokens:
          modelMaxTokens ??
          (providerMaxTokens !== undefined
            ? Math.min(
                providerMaxTokens,
                model.contextWindow ?? providerMaxTokens,
                model.contextTokens ?? providerMaxTokens,
              )
            : model.maxTokens),
      };
    }),
  };
}
