/**
 * Converts inline provider model config into runtime model definitions.
 */
import { normalizeResolvedPricing } from "@openclaw/llm-core";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { MODEL_APIS } from "../../config/model-config-vocabulary.js";
import { resolveMergedModelProviderModels } from "../../config/model-provider-config.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../../config/types.js";
import { normalizeGoogleApiBaseUrl } from "../../infra/google-api-base-url.js";
import type { Api } from "../../llm/types.js";
import type { PluginMetadataSnapshotOwnerMaps } from "../../plugins/plugin-metadata-snapshot.types.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { isStringOption } from "../../utils/string-readers.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { isSecretRefHeaderValueMarker } from "../model-auth-markers.js";
import { attachModelProviderLocalService } from "../provider-local-service.js";
import {
  attachModelProviderRequestRouteFacts,
  attachModelProviderRequestTransport,
  resolveProviderRequestConfig,
  sanitizeConfiguredModelProviderRequest,
} from "../provider-request-config.js";

/**
 * Normalizes inline `models.providers` config into runtime model entries.
 */
export type InlineModelEntry = Omit<ModelDefinitionConfig, "api" | "contextWindow"> & {
  api?: Api;
  contextWindow?: number;
  provider: string;
  baseUrl?: string;
  headers?: Record<string, string>;
};

export type InlineProviderConfig = {
  baseUrl?: string;
  api?: ModelDefinitionConfig["api"];
  models?: ModelDefinitionConfig[];
  maxTokens?: ModelProviderConfig["maxTokens"];
  params?: ModelProviderConfig["params"];
  headers?: unknown;
  authHeader?: boolean;
  timeoutSeconds?: ModelProviderConfig["timeoutSeconds"];
  request?: ModelProviderConfig["request"];
  localService?: ModelProviderConfig["localService"];
};

/** Returns a supported transport API id from raw config values. */
export function normalizeResolvedTransportApi(
  api: unknown,
): ModelDefinitionConfig["api"] | undefined {
  return isStringOption(api, MODEL_APIS) ? api : undefined;
}

/** Sanitizes configured provider/model headers before they enter runtime model metadata. */
export function sanitizeModelHeaders(headers: unknown): Record<string, string> | undefined {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return undefined;
  }
  const next: Record<string, string> = {};
  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (typeof headerValue !== "string" || isSecretRefHeaderValueMarker(headerValue)) {
      // Catalog/runtime model records are inspectable. Secret-ref markers are resolved later during
      // auth setup, so inline provider discovery must not expose them as literal headers.
      continue;
    }
    next[headerName] = headerValue;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function isLegacyFoundryVisionModelCandidate(params: {
  provider?: string;
  modelId?: string;
  modelName?: string;
}): boolean {
  if (normalizeOptionalLowercaseString(params.provider) !== "microsoft-foundry") {
    return false;
  }
  const normalizedCandidates = [params.modelId, params.modelName]
    .map((value) => normalizeOptionalLowercaseString(value))
    .filter((value): value is string => Boolean(value));
  return normalizedCandidates.some(
    (candidate) =>
      ["gpt-", "o1", "o3", "o4"].some((prefix) => candidate.startsWith(prefix)) ||
      candidate === "computer-use-preview",
  );
}

/** Resolves model input modalities with Foundry legacy vision-model compatibility. */
export function resolveProviderModelInput(params: {
  provider?: string;
  modelId?: string;
  modelName?: string;
  input?: unknown;
  fallbackInput?: unknown;
}): Array<"text" | "image"> {
  const resolvedInput = Array.isArray(params.input) ? params.input : params.fallbackInput;
  const normalizedInput = Array.isArray(resolvedInput)
    ? resolvedInput.filter((item): item is "text" | "image" => item === "text" || item === "image")
    : [];
  if (
    normalizedInput.length > 0 &&
    !normalizedInput.includes("image") &&
    isLegacyFoundryVisionModelCandidate(params)
  ) {
    return ["text", "image"];
  }
  return normalizedInput.length > 0 ? normalizedInput : ["text"];
}

export function buildInlineProviderModels(
  providers: Record<string, InlineProviderConfig>,
  options: { providerMetadataOwners?: PluginMetadataSnapshotOwnerMaps } = {},
): InlineModelEntry[] {
  return Object.entries(providers).flatMap(([providerId, entry]) => {
    const trimmed = providerId.trim();
    if (!trimmed) {
      return [];
    }
    const providerHeaders = sanitizeModelHeaders(entry?.headers);
    const providerRequest = sanitizeConfiguredModelProviderRequest(entry?.request);
    // Provider defaults must not mask omissions before exact duplicate rows merge.
    const models = resolveMergedModelProviderModels({
      models: entry?.models,
      normalizeModelId: (modelId) => modelId.trim(),
    });
    return Array.from(models.values()).map((model) => {
      const api = normalizeResolvedTransportApi(model.api ?? entry?.api);
      const configuredBaseUrl = model.baseUrl ?? entry?.baseUrl;
      const baseUrl =
        api === "google-generative-ai"
          ? normalizeGoogleApiBaseUrl(configuredBaseUrl)
          : configuredBaseUrl;
      const modelHeaders = sanitizeModelHeaders(model.headers);
      const requestConfig = resolveProviderRequestConfig({
        provider: trimmed,
        api: api ?? model.api,
        baseUrl,
        ...(options.providerMetadataOwners
          ? { providerMetadataOwners: options.providerMetadataOwners }
          : {}),
        providerHeaders,
        modelHeaders,
        authHeader: entry?.authHeader,
        request: providerRequest,
        capability: "llm",
        transport: "stream",
      });
      const maxTokens = model.maxTokens ?? entry?.maxTokens;
      return attachModelProviderRequestRouteFacts(
        attachModelProviderLocalService(
          attachModelProviderRequestTransport(
            {
              ...model,
              ...(maxTokens !== undefined ? { maxTokens } : {}),
              input: resolveProviderModelInput({
                provider: trimmed,
                modelId: model.id,
                modelName: model.name,
                input: model.input,
              }),
              provider: trimmed,
              baseUrl: requestConfig.baseUrl ?? baseUrl,
              api: requestConfig.api ?? model.api,
              headers: requestConfig.headers,
            },
            providerRequest,
          ),
          entry?.localService,
        ),
        options.providerMetadataOwners,
      );
    });
  });
}

/** Completes captured inline definitions with the same contract used by static catalogs. */
export function completeInlineProviderModel(
  model: InlineModelEntry,
  providerConfig: ModelProviderConfig,
): ProviderRuntimeModel {
  return {
    ...model,
    name: model.name || model.id,
    api: model.api ?? providerConfig.api ?? "openai-responses",
    baseUrl: model.baseUrl ?? "",
    reasoning: model.reasoning ?? false,
    input: resolveProviderModelInput({
      provider: model.provider,
      modelId: model.id,
      modelName: model.name,
      input: model.input,
    }),
    cost: model.cost ?? normalizeResolvedPricing({}),
    contextWindow:
      model.contextWindow ?? Math.max(model.contextTokens ?? 0, DEFAULT_CONTEXT_TOKENS),
    ...(model.contextWindow === undefined ? { contextWindowSource: "synthetic" as const } : {}),
    contextTokens: model.contextTokens,
    maxTokens: model.maxTokens ?? DEFAULT_CONTEXT_TOKENS,
    ...(providerConfig.authHeader !== undefined ? { authHeader: providerConfig.authHeader } : {}),
  };
}
