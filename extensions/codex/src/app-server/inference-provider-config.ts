import type { CodexInferenceProxy } from "./inference-proxy.js";
import { isJsonObject, type JsonObject } from "./protocol.js";

export type ProviderKind = "openai" | "azure" | "other";

export function providerKind(name: unknown): ProviderKind | undefined {
  if (name === "Amazon Bedrock" || name === "Amazon Bedrock Runtime") {
    return undefined;
  }
  return name === "OpenAI"
    ? "openai"
    : typeof name === "string" && name.toLowerCase() === "azure"
      ? "azure"
      : "other";
}

export function hasProviderAws(config: JsonObject | undefined, provider: string): boolean {
  return (
    readProviderField(config, provider, "aws") != null ||
    Object.keys(config ?? {}).some((key) => key.startsWith(`model_providers.${provider}.aws.`))
  );
}

export function configuredProviders(...configs: (JsonObject | undefined)[]): Set<string> {
  const providers = new Set(["openai"]);
  for (const config of configs) {
    for (const provider of Object.keys(
      isJsonObject(config?.model_providers) ? config.model_providers : {},
    )) {
      providers.add(provider);
    }
    for (const key of Object.keys(config ?? {})) {
      const provider = /^model_providers\.([^.]+)(?:\.|$)/.exec(key)?.[1];
      if (provider) {
        providers.add(provider);
      }
    }
  }
  return providers;
}

export function projectProviderRoutes(
  config: JsonObject | undefined,
  providers: ReadonlyMap<string, CodexInferenceProxy>,
): JsonObject {
  let projected = config ?? {};
  for (const [provider, route] of providers) {
    projected = withProviderBaseUrl(projected, provider, route.baseUrl);
  }
  return projected;
}

export function readProviderBaseUrl(config: JsonObject | undefined, provider: string): unknown {
  if (provider === "openai") {
    return config?.openai_base_url;
  }
  return readProviderField(config, provider, "base_url");
}

export function readProviderField(
  config: JsonObject | undefined,
  provider: string,
  field: string,
): unknown {
  const providers = isJsonObject(config?.model_providers) ? config.model_providers : undefined;
  const selected = providers?.[provider];
  const flat = config?.[`model_providers.${provider}`];
  return (
    config?.[`model_providers.${provider}.${field}`] ??
    (isJsonObject(flat) ? flat[field] : undefined) ??
    (isJsonObject(selected) ? selected[field] : undefined)
  );
}

export function withProviderBaseUrl(
  config: JsonObject | undefined,
  provider: string,
  baseUrl: string,
): JsonObject {
  if (provider === "openai") {
    return { ...config, openai_base_url: baseUrl };
  }
  const providers = isJsonObject(config?.model_providers) ? config.model_providers : {};
  const selected = providers[provider];
  const providerKey = `model_providers.${provider}`;
  const baseUrlKey = `${providerKey}.base_url`;
  const flat = config?.[providerKey];
  // A sparse native table overlay changes only this URL; native still owns auth and headers.
  return {
    ...config,
    model_providers: {
      ...providers,
      [provider]: { ...(isJsonObject(selected) ? selected : {}), base_url: baseUrl },
    },
    ...(isJsonObject(flat) ? { [providerKey]: { ...flat, base_url: baseUrl } } : {}),
    ...(config?.[baseUrlKey] !== undefined ? { [baseUrlKey]: baseUrl } : {}),
  };
}
