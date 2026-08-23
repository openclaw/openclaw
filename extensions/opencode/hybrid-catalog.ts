// Hybrid OpenCode Zen catalog: gateway IDs + models.dev metadata + static policy.
import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import {
  buildHybridProviderConfig,
  HybridDynamicModelStore,
  fetchModelsDevProviderSlice,
  type HybridModelDefinition,
  type HybridTransport,
} from "openclaw/plugin-sdk/provider-catalog-hybrid-runtime";
import type { LiveModelCatalogFetchGuard } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";

const MODELS_DEV_PROVIDER_KEY = "opencode";
const GPT_56_MODEL_IDS = new Set(["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]);
const GPT_56_REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"];

const hybridModelStore = new HybridDynamicModelStore();
let lastCatalogAuthKey: string | undefined;

export function clearOpencodeHybridCatalogStateForTests(): void {
  hybridModelStore.clear();
  lastCatalogAuthKey = undefined;
}

export function resolveOpencodeZenFamilyTransport(
  modelId: string,
  openaiBaseUrl: string,
  anthropicBaseUrl: string,
): HybridTransport {
  const lower = modelId.toLowerCase();
  if (lower.startsWith("gpt-") || lower.startsWith("grok-")) {
    return { api: "openai-responses", baseUrl: openaiBaseUrl };
  }
  if (lower.startsWith("claude-") || lower.startsWith("qwen")) {
    return { api: "anthropic-messages", baseUrl: anthropicBaseUrl };
  }
  if (lower.startsWith("gemini-")) {
    return { api: "google-generative-ai", baseUrl: openaiBaseUrl };
  }
  return { api: "openai-completions", baseUrl: openaiBaseUrl };
}

export function applyOpencodeZenPolicyOverlay(
  model: HybridModelDefinition,
  staticBase: HybridModelDefinition | undefined,
): HybridModelDefinition {
  const compat = {
    supportsUsageInStreaming: true,
    supportsReasoningEffort: model.reasoning,
    maxTokensField: "max_tokens" as const,
    ...staticBase?.compat,
    ...model.compat,
  };
  if (GPT_56_MODEL_IDS.has(model.id)) {
    compat.supportedReasoningEfforts = GPT_56_REASONING_EFFORTS;
    compat.supportsReasoningEffort = true;
  }
  return {
    ...model,
    ...(staticBase?.thinkingLevelMap ? { thinkingLevelMap: staticBase.thinkingLevelMap } : {}),
    compat,
  };
}

export async function buildOpencodeZenHybridProviderConfig(params: {
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
  providerId?: string;
  now?: () => number;
  gatewayIdsTtlMs?: number;
  hybridSuccessTtlMs?: number;
}): Promise<ModelProviderConfig> {
  const providerId = params.providerId ?? "opencode";
  const resolveTransport = (modelId: string) =>
    resolveOpencodeZenFamilyTransport(modelId, params.openaiBaseUrl, params.anthropicBaseUrl);

  return await buildHybridProviderConfig({
    providerId,
    apiKey: params.apiKey,
    discoveryApiKey: params.discoveryApiKey,
    fetchGuard: params.fetchGuard,
    signal: params.signal,
    fetchModelsDev: params.fetchModelsDev,
    modelsDevProviderKey: MODELS_DEV_PROVIDER_KEY,
    staticModels: params.staticModels,
    gatewayEndpoint: params.gatewayEndpoint,
    gatewayTimeoutMs: params.gatewayTimeoutMs,
    gatewayAuditContext: "opencode-zen-model-discovery",
    openaiBaseUrl: params.openaiBaseUrl,
    resolveTransport,
    applyPolicyOverlay: applyOpencodeZenPolicyOverlay,
    skipGatewayIds: params.skipGatewayIds,
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

/**
 * Best-effort models.dev prewarm at gateway start.
 * Full hybrid still lazy single-flights on first catalog need when auth is available.
 */
export async function prewarmOpencodeZenHybridCatalog(): Promise<void> {
  try {
    await fetchModelsDevProviderSlice({ providerKey: MODELS_DEV_PROVIDER_KEY });
  } catch {
    // Prewarm is best-effort.
  }
}
