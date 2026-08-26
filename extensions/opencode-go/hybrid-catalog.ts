// Hybrid OpenCode Go catalog: gateway IDs + models.dev metadata + static policy.
import {
  buildHybridProviderConfig,
  type HybridModelDefinition,
  type HybridTransport,
} from "openclaw/plugin-sdk/provider-catalog-hybrid-runtime";
import type { LiveModelCatalogFetchGuard } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";

const PROVIDER_ID = "opencode-go";
const MODELS_DEV_PROVIDER_KEY = "opencode-go";

function resolveOpencodeGoFamilyTransport(
  modelId: string,
  openaiBaseUrl: string,
  anthropicBaseUrl: string,
): HybridTransport {
  const lower = modelId.toLowerCase();
  if (lower.startsWith("gpt-")) {
    return { api: "openai-responses", baseUrl: openaiBaseUrl };
  }
  if (lower.startsWith("minimax-") || lower.startsWith("qwen")) {
    return { api: "anthropic-messages", baseUrl: anthropicBaseUrl };
  }
  return { api: "openai-completions", baseUrl: openaiBaseUrl };
}

function applyOpencodeGoPolicyOverlay(
  model: HybridModelDefinition,
  staticBase: HybridModelDefinition | undefined,
): HybridModelDefinition {
  const lower = model.id.toLowerCase();
  let next: HybridModelDefinition = {
    ...model,
    ...(staticBase?.thinkingLevelMap ? { thinkingLevelMap: staticBase.thinkingLevelMap } : {}),
    compat: {
      supportsUsageInStreaming: true,
      supportsReasoningEffort: model.reasoning,
      maxTokensField: "max_tokens",
      ...staticBase?.compat,
      ...model.compat,
    },
  };
  // Shipped Go policy: qwen rows without explicit efforts speak the qwen
  // thinking format; rows carrying effort enums never get thinkingFormat.
  if (lower.startsWith("qwen") && !next.compat?.supportedReasoningEfforts) {
    next = {
      ...next,
      compat: {
        ...next.compat,
        thinkingFormat: "qwen",
      },
    };
  }
  return next;
}

export async function buildOpencodeGoHybridProviderConfig(params: {
  apiKey?: string;
  discoveryApiKey?: string;
  fetchGuard?: LiveModelCatalogFetchGuard;
  signal?: AbortSignal;
  fetchModelsDev?: () => Promise<unknown>;
  staticModels: readonly HybridModelDefinition[];
  gatewayEndpoint: string;
  gatewayTimeoutMs: number;
  openaiBaseUrl: string;
  anthropicBaseUrl: string;
  skipGatewayIds?: ReadonlySet<string>;
  now?: () => number;
  gatewayIdsTtlMs?: number;
  hybridSuccessTtlMs?: number;
}): Promise<ModelProviderConfig> {
  const resolveTransport = (modelId: string) =>
    resolveOpencodeGoFamilyTransport(modelId, params.openaiBaseUrl, params.anthropicBaseUrl);

  return await buildHybridProviderConfig({
    providerId: PROVIDER_ID,
    apiKey: params.apiKey,
    discoveryApiKey: params.discoveryApiKey,
    fetchGuard: params.fetchGuard,
    signal: params.signal,
    fetchModelsDev: params.fetchModelsDev,
    modelsDevProviderKey: MODELS_DEV_PROVIDER_KEY,
    modelsDevInjectedCacheKeySuffix: PROVIDER_ID,
    staticModels: params.staticModels,
    gatewayEndpoint: params.gatewayEndpoint,
    gatewayTimeoutMs: params.gatewayTimeoutMs,
    gatewayAuditContext: "opencode-go-model-discovery",
    openaiBaseUrl: params.openaiBaseUrl,
    resolveTransport,
    applyPolicyOverlay: applyOpencodeGoPolicyOverlay,
    skipGatewayIds: params.skipGatewayIds,
    gatewayIdsTtlMs: params.gatewayIdsTtlMs,
    hybridSuccessTtlMs: params.hybridSuccessTtlMs,
    now: params.now,
  });
}
