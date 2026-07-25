// Hybrid OpenCode Go catalog: gateway IDs + models.dev metadata + static policy.
import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import {
  buildHybridProviderConfig,
  HybridDynamicModelStore,
  MODELS_DEV_PROCESS_STICKY_TTL_MS,
  GATEWAY_MODEL_IDS_TTL_MS,
  buildHybridModelDefinitions,
  fetchModelsDevProviderSlice,
  parseModelsDevProviderSlice,
  type HybridModelDefinition,
  type HybridTransport,
  type ModelsDevProviderSlice,
} from "openclaw/plugin-sdk/provider-catalog-hybrid-runtime";
import type { LiveModelCatalogFetchGuard } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";

export {
  MODELS_DEV_API_URL,
  MODELS_DEV_TIMEOUT_MS,
  parseModelsDevProviderSlice,
  buildHybridModelDefinitions,
  type HybridModelDefinition,
  type HybridTransport,
  type ModelsDevProviderSlice,
} from "openclaw/plugin-sdk/provider-catalog-hybrid-runtime";

/** @deprecated Use MODELS_DEV_PROCESS_STICKY_TTL_MS for metadata; gateway uses GATEWAY_MODEL_IDS_TTL_MS. */
export const PROCESS_STICKY_TTL_MS = MODELS_DEV_PROCESS_STICKY_TTL_MS;
export { MODELS_DEV_PROCESS_STICKY_TTL_MS, GATEWAY_MODEL_IDS_TTL_MS };

const PROVIDER_ID = "opencode-go";
const MODELS_DEV_PROVIDER_KEY = "opencode-go";
const OPENCODE_GO_DEEPSEEK_V4_THINKING_LEVEL_MAP = {
  minimal: "high",
  low: "high",
  medium: "high",
  high: "high",
  xhigh: "max",
  max: "max",
} as const;
const DEPRECATED_GATEWAY_IDS = new Set(["mimo-v2-omni", "mimo-v2-pro"]);

const hybridModelStore = new HybridDynamicModelStore();
let lastCatalogAuthKey: string | undefined;

export function clearOpencodeGoHybridCatalogStateForTests(): void {
  hybridModelStore.clear();
  lastCatalogAuthKey = undefined;
}

export function resolveOpencodeGoFamilyTransport(
  modelId: string,
  openaiBaseUrl: string,
  anthropicBaseUrl: string,
): HybridTransport {
  const lower = modelId.toLowerCase();
  if (lower.startsWith("minimax-")) {
    return { api: "anthropic-messages", baseUrl: anthropicBaseUrl };
  }
  if (lower.startsWith("qwen") && lower !== "qwen3.5-plus") {
    return { api: "anthropic-messages", baseUrl: anthropicBaseUrl };
  }
  return { api: "openai-completions", baseUrl: openaiBaseUrl };
}

export function applyOpencodeGoPolicyOverlay(
  model: HybridModelDefinition,
  staticBase: HybridModelDefinition | undefined,
): HybridModelDefinition {
  const lower = model.id.toLowerCase();
  let next: HybridModelDefinition = {
    ...model,
    ...(staticBase?.thinkingLevelMap ? { thinkingLevelMap: staticBase.thinkingLevelMap } : {}),
    compat: {
      supportsUsageInStreaming: true,
      supportsReasoningEffort: model.reasoning !== false,
      maxTokensField: "max_tokens",
      ...(staticBase?.compat ?? {}),
      ...(model.compat ?? {}),
    },
  };
  if (lower.startsWith("deepseek-v4") && !next.thinkingLevelMap) {
    next = { ...next, thinkingLevelMap: OPENCODE_GO_DEEPSEEK_V4_THINKING_LEVEL_MAP };
  }
  if (lower.startsWith("qwen")) {
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
    skipGatewayIds: DEPRECATED_GATEWAY_IDS,
    gatewayIdsTtlMs: params.gatewayIdsTtlMs,
    hybridSuccessTtlMs: params.hybridSuccessTtlMs,
    now: params.now,
    onResolvedModels: (authKey, models) => {
      lastCatalogAuthKey = authKey;
      hybridModelStore.set(authKey, models);
    },
  });
}

export function resolveHybridDynamicModel(
  modelId: string,
  staticModels: readonly HybridModelDefinition[],
  authKey?: string,
): ProviderRuntimeModel | undefined {
  return hybridModelStore.resolve(modelId, staticModels, authKey ?? lastCatalogAuthKey);
}

export async function prewarmOpencodeGoHybridCatalog(): Promise<void> {
  try {
    await fetchModelsDevProviderSlice({
      providerKey: MODELS_DEV_PROVIDER_KEY,
      injectedCacheKeySuffix: PROVIDER_ID,
    });
  } catch {
    // Prewarm is best-effort.
  }
}
