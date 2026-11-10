import type { Model } from "../../llm/types.js";
import { modelTransportRoutesMatch } from "../model-compat-catalog.js";
import type { ReadonlyAuthStorage } from "./auth-storage-readonly.js";
import type { ProviderRequestConfig } from "./model-registry-sources.js";

/** Registry availability describes host credentials, never a native runtime's command. */
export function hasModelRegistryConfiguredAuth(params: {
  model: Model;
  providerConfig: ProviderRequestConfig | undefined;
  authStorage: Pick<ReadonlyAuthStorage, "hasAuth">;
}): boolean {
  const { model, providerConfig, authStorage } = params;
  if (providerConfig?.auth === "native-command") {
    return false;
  }
  if (providerConfig?.auth === "none") {
    return model.api === "openai-completions";
  }
  return (
    authStorage.hasAuth(model.provider) ||
    providerConfig?.auth === "aws-sdk" ||
    providerConfig?.apiKey !== undefined
  );
}

export function getModelRegistryProviderRequestConfig(
  model: Model,
  providerRequestConfigs: ReadonlyMap<string, ProviderRequestConfig>,
): ProviderRequestConfig | undefined {
  const config = providerRequestConfigs.get(model.provider);
  if (
    config?.baseUrls &&
    !config.baseUrls.some((baseUrl) =>
      modelTransportRoutesMatch({ baseUrl }, { baseUrl: model.baseUrl }),
    )
  ) {
    return undefined;
  }
  return config;
}
