import { finiteSecondsToTimerSafeMilliseconds } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { findConfiguredProviderModel } from "../../config/model-provider-config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { Model } from "../../llm/types.js";
import type { PluginMetadataSnapshotOwnerMaps } from "../../plugins/plugin-metadata-snapshot.types.js";
import { createProviderModelCatalogIdNormalizer } from "../../plugins/provider-model-routes.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { resolveCatalogOwnedModelCompat } from "../model-compat-catalog.js";
import { attachModelProviderLocalService } from "../provider-local-service.js";
import {
  attachModelProviderRequestRouteFacts,
  attachModelProviderRequestTransport,
  resolveProviderRequestConfig,
  sanitizeConfiguredModelProviderRequest,
} from "../provider-request-config.js";
import { mergeModelMediaInput, resolveMergedConfiguredModelReasoning } from "./model.compat.js";
import {
  clampModelMaxTokensToContextWindow,
  hasConfiguredModelRouteSupport,
  mergeConfiguredRuntimeModelParams,
  mergeConfiguredModelCost,
  resolveConfiguredProviderConfig,
  resolveConfiguredProviderDefaultApi,
  shouldSuppressConfiguredModel,
} from "./model.configured-overrides.js";
import {
  normalizeResolvedTransportApi,
  resolveProviderModelInput,
  sanitizeModelHeaders,
} from "./model.inline-provider.js";
import { normalizeResolvedModel, type ProviderRuntimeHooks } from "./model.provider-hooks.js";
import { resolveProviderTransport } from "./model.provider-transport.js";
import type { ManifestModelCatalogProviderAliasMetadata } from "./model.static-catalog.js";

export function buildConfiguredFallbackModel(params: {
  provider: string;
  modelId: string;
  cfg?: OpenClawConfig;
  agentDir?: string;
  manifestAlias: ManifestModelCatalogProviderAliasMetadata;
  providerMetadataOwners?: PluginMetadataSnapshotOwnerMaps;
  getStaticCatalogModel?: () => ProviderRuntimeModel | undefined;
  workspaceDir?: string;
  runtimeHooks?: ProviderRuntimeHooks;
}): Model | undefined {
  const { provider, modelId, cfg } = params;
  const providerConfig = resolveConfiguredProviderConfig(cfg, provider);
  const requestTimeoutMs = finiteSecondsToTimerSafeMilliseconds(providerConfig?.timeoutSeconds, {
    floorSeconds: true,
  });
  const configuredModel = findConfiguredProviderModel(
    providerConfig,
    provider,
    modelId,
    createProviderModelCatalogIdNormalizer(provider),
  );
  if (!configuredModel && !providerConfig?.baseUrl?.trim()) {
    return undefined;
  }
  const staticCatalogModel = params.getStaticCatalogModel?.();
  const metadataModel = configuredModel ?? staticCatalogModel;
  const fallbackMediaInput = mergeModelMediaInput(
    staticCatalogModel?.mediaInput,
    configuredModel?.mediaInput,
  );
  const providerHeaders = sanitizeModelHeaders(providerConfig?.headers);
  const providerRequest = sanitizeConfiguredModelProviderRequest(providerConfig?.request);
  const staticCatalogHeaders = sanitizeModelHeaders(staticCatalogModel?.headers);
  const modelHeaders = sanitizeModelHeaders(configuredModel?.headers);
  const resolvedParams = mergeConfiguredRuntimeModelParams({
    ...params,
    discoveredParams: staticCatalogModel?.params,
    providerParams: providerConfig?.params,
    configuredParams: configuredModel?.params,
  });
  const providerConfiguredApi = normalizeResolvedTransportApi(providerConfig?.api);
  const configuredModelBaseUrl = normalizeOptionalString(configuredModel?.baseUrl);
  const providerConfiguredBaseUrl = normalizeOptionalString(providerConfig?.baseUrl);
  const manifestAliasTransport = params.manifestAlias.transport;
  const manifestAliasBaseUrl = normalizeOptionalString(manifestAliasTransport?.baseUrl);
  const staticCatalogBaseUrl = normalizeOptionalString(staticCatalogModel?.baseUrl);
  const fallbackTransport = resolveProviderTransport({
    ...params,
    api:
      normalizeResolvedTransportApi(configuredModel?.api) ??
      providerConfiguredApi ??
      manifestAliasTransport?.api ??
      normalizeResolvedTransportApi(staticCatalogModel?.api) ??
      resolveConfiguredProviderDefaultApi({
        ...params,
        providerConfig,
      }) ??
      "openai-responses",
    baseUrl:
      configuredModelBaseUrl ??
      providerConfiguredBaseUrl ??
      manifestAliasBaseUrl ??
      staticCatalogBaseUrl,
  });
  if (
    !hasConfiguredModelRouteSupport({
      ...params,
      configuredModel,
      catalogModel: staticCatalogModel,
      route: fallbackTransport,
    })
  ) {
    return undefined;
  }
  const fallbackCompat = resolveCatalogOwnedModelCompat({
    ...(staticCatalogModel ? { catalogRoute: staticCatalogModel } : {}),
    catalogCompat: staticCatalogModel?.compat,
    configuredRoute: fallbackTransport,
    configuredCompat: configuredModel?.compat,
  });
  if (
    configuredModel &&
    shouldSuppressConfiguredModel({
      ...params,
      baseUrl: fallbackTransport.baseUrl,
    })
  ) {
    return undefined;
  }
  const requestConfig = resolveProviderRequestConfig({
    provider,
    api: fallbackTransport.api ?? "openai-responses",
    baseUrl: fallbackTransport.baseUrl,
    ...(params.providerMetadataOwners
      ? { providerMetadataOwners: params.providerMetadataOwners }
      : {}),
    discoveredHeaders: staticCatalogHeaders,
    providerHeaders,
    modelHeaders,
    authHeader: providerConfig?.authHeader,
    request: providerRequest,
    capability: "llm",
    transport: "stream",
  });
  const fallbackReasoning = resolveMergedConfiguredModelReasoning({
    provider,
    compat: fallbackCompat,
    configuredReasoning: metadataModel?.reasoning,
  });
  const configuredFallbackMaxTokens = configuredModel?.maxTokens ?? providerConfig?.maxTokens;
  const resolvedFallbackMaxTokens = configuredFallbackMaxTokens ?? staticCatalogModel?.maxTokens;
  const resolvedFallbackContextWindow =
    configuredModel?.contextWindow ?? staticCatalogModel?.contextWindow ?? DEFAULT_CONTEXT_TOKENS;
  const normalizedResolvedFallbackMaxTokens = clampModelMaxTokensToContextWindow(
    resolvedFallbackMaxTokens,
    resolvedFallbackContextWindow,
  );
  return normalizeResolvedModel({
    ...params,
    model: attachModelProviderRequestRouteFacts(
      attachModelProviderLocalService(
        attachModelProviderRequestTransport(
          {
            id: modelId,
            name: metadataModel?.name ?? modelId,
            api: requestConfig.api ?? "openai-responses",
            provider,
            baseUrl: requestConfig.baseUrl,
            reasoning: fallbackReasoning,
            input: resolveProviderModelInput({
              provider,
              modelId,
              modelName: metadataModel?.name ?? modelId,
              input: metadataModel?.input,
            }),
            ...(configuredModel?.thinkingLevelMap !== undefined
              ? { thinkingLevelMap: configuredModel.thinkingLevelMap }
              : {}),
            cost: mergeConfiguredModelCost({
              ...params,
              configuredModel,
              catalogCost: staticCatalogModel?.cost,
            }),
            contextWindow: resolvedFallbackContextWindow,
            contextTokens: configuredModel?.contextTokens ?? staticCatalogModel?.contextTokens,
            // maxTokens is a wire-level output cap, not a context-budget fallback.
            // Omit an unknown cap so strict providers can apply their own limit.
            ...(normalizedResolvedFallbackMaxTokens !== undefined
              ? {
                  maxTokens: normalizedResolvedFallbackMaxTokens,
                  maxTokensSource:
                    configuredFallbackMaxTokens !== undefined ? "configured" : "discovered",
                }
              : {}),
            ...(resolvedParams ? { params: resolvedParams } : {}),
            ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
            headers: requestConfig.headers,
            ...(providerConfig?.authHeader !== undefined
              ? { authHeader: providerConfig.authHeader }
              : {}),
            compat: fallbackCompat,
            mediaInput: fallbackMediaInput,
          } as Model,
          providerRequest,
        ),
        providerConfig?.localService,
      ),
      params.providerMetadataOwners,
    ),
  });
}
