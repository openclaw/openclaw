import type { Model } from "../../llm/types.js";
import { isLikelySensitiveModelProviderHeaderName } from "../../secrets/model-provider-header-policy.js";
import { sanitizeModelHeaders } from "../embedded-agent-runner/model.inline-provider.js";
import { modelTransportRoutesMatch } from "../model-compat-catalog.js";
import type { ProviderModelCatalog } from "../models-config.merge.js";
import type { ModelsConfig, ProviderAuthMode } from "./model-registry-schema.js";

export type RegistryProviderSources = Record<
  string,
  ProviderModelCatalog &
    Pick<ModelsConfig["providers"][string], "apiKey" | "auth" | "authHeader"> & {
      headers?: Record<string, string>;
    }
>;

export interface ProviderRequestConfig {
  baseUrls?: readonly string[];
  apiKey?: string;
  auth?: ProviderAuthMode;
  headers?: Record<string, string>;
  authHeader?: boolean;
}

function sanitizeFallbackRequestHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const sanitized = sanitizeModelHeaders(headers, { stripSecretRefMarkers: true });
  if (!sanitized) {
    return undefined;
  }
  const safe = Object.fromEntries(
    Object.entries(sanitized).filter(([name]) => !isLikelySensitiveModelProviderHeaderName(name)),
  );
  return Object.keys(safe).length > 0 ? safe : undefined;
}

export function getModelRequestKey(provider: string, modelId: string): string {
  return JSON.stringify([provider, modelId]);
}

export function applySanitizedFallbackRequestHeaders(params: {
  fallbackProviders: RegistryProviderSources;
  models: readonly Model[];
  providerRequestConfigs: ReadonlyMap<string, { headers?: Record<string, string> }>;
  modelRequestHeaders: Map<string, Record<string, string>>;
}): void {
  for (const model of params.models) {
    const fallbackProvider = params.fallbackProviders[model.provider];
    const fallbackModel = fallbackProvider?.models?.find(
      (candidate) => candidate.id === model.id && modelTransportRoutesMatch(candidate, model),
    );
    if (!fallbackProvider || !fallbackModel) {
      continue;
    }

    const fallbackHeaders = {
      ...sanitizeFallbackRequestHeaders(fallbackProvider.headers),
      ...sanitizeFallbackRequestHeaders(fallbackModel.headers),
    };
    if (Object.keys(fallbackHeaders).length === 0) {
      continue;
    }

    const key = getModelRequestKey(model.provider, model.id);
    const currentProviderHeaders = params.providerRequestConfigs.get(model.provider)?.headers;
    const currentModelHeaders = params.modelRequestHeaders.get(key);
    const currentHeaderNames = new Set(
      [...Object.keys(currentProviderHeaders ?? {}), ...Object.keys(currentModelHeaders ?? {})].map(
        (name) => name.toLowerCase(),
      ),
    );
    const inheritedHeaders = Object.fromEntries(
      Object.entries(fallbackHeaders).filter(
        ([name]) => !currentHeaderNames.has(name.toLowerCase()),
      ),
    );
    const headers = { ...inheritedHeaders, ...currentModelHeaders };
    if (Object.keys(headers).length === 0) {
      params.modelRequestHeaders.delete(key);
    } else {
      params.modelRequestHeaders.set(key, headers);
    }
  }
}
