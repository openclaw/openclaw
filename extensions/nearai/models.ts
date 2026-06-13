import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type {
  ModelCompatConfig,
  ModelDefinitionConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import { createSubsystemLogger, retryAsync } from "openclaw/plugin-sdk/runtime-env";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const PROVIDER_ID = "nearai";
const log = createSubsystemLogger("nearai-models");

const NEARAI_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
  providerId: PROVIDER_ID,
  catalog: manifest.modelCatalog.providers.nearai,
});

export const NEARAI_BASE_URL = NEARAI_MANIFEST_PROVIDER.baseUrl;
const NEARAI_MODEL_LIST_URL = `${NEARAI_BASE_URL}/model/list`;
const NEARAI_DEFAULT_MODEL_ID = "zai-org/GLM-5.1-FP8";
export const NEARAI_DEFAULT_MODEL_REF = `${PROVIDER_ID}/${NEARAI_DEFAULT_MODEL_ID}`;
const NEARAI_ALLOWED_HOSTNAMES = ["cloud-api.near.ai"];

const NEARAI_DEFAULT_CONTEXT_WINDOW = 128_000;
const NEARAI_DISCOVERY_MAX_TOKENS = 65_536;
const NEARAI_DISCOVERY_TIMEOUT_MS = 10_000;
const NEARAI_DISCOVERY_RETRYABLE_HTTP_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const NEARAI_DISCOVERY_RETRYABLE_NETWORK_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_CONNECT_ERROR",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const NEARAI_OPENAI_COMPAT: ModelCompatConfig = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  supportsUsageInStreaming: false,
  supportsStrictMode: false,
  maxTokensField: "max_tokens",
};

export const NEARAI_MODEL_CATALOG: ModelDefinitionConfig[] = NEARAI_MANIFEST_PROVIDER.models;

type NearAICatalogEntry = ModelDefinitionConfig;

type NearAICost = {
  amount?: unknown;
  scale?: unknown;
};

type NearAIModelMetadata = {
  contextLength?: unknown;
  modelDisplayName?: unknown;
  modelDescription?: unknown;
  architecture?: {
    inputModalities?: unknown;
    outputModalities?: unknown;
  };
};

type NearAIModel = {
  modelId?: unknown;
  inputCostPerToken?: NearAICost;
  outputCostPerToken?: NearAICost;
  cacheReadCostPerToken?: NearAICost;
  metadata?: NearAIModelMetadata;
};

type NearAIModelsResponse = {
  models?: unknown;
};

class NearAIDiscoveryHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`HTTP ${status}`);
    this.name = "NearAIDiscoveryHttpError";
    this.status = status;
  }
}

export function applyNearAIModelCompat<T extends { compat?: ModelCompatConfig }>(model: T): T {
  const nextCompat = {
    ...model.compat,
    ...NEARAI_OPENAI_COMPAT,
  };
  const currentCompat = model.compat as Record<string, unknown> | undefined;
  const hasCompat = Object.entries(NEARAI_OPENAI_COMPAT).every(
    ([key, value]) => currentCompat?.[key] === value,
  );
  if (model.compat && hasCompat) {
    return model;
  }
  return {
    ...model,
    compat: nextCompat,
  };
}

export function buildNearAIModelDefinition(entry: NearAICatalogEntry): ModelDefinitionConfig {
  return applyNearAIModelCompat({
    id: entry.id,
    name: entry.name,
    reasoning: entry.reasoning,
    input: [...entry.input],
    cost: {
      input: entry.cost.input,
      output: entry.cost.output,
      cacheRead: entry.cost.cacheRead,
      cacheWrite: entry.cost.cacheWrite,
      ...(entry.cost.tieredPricing ? { tieredPricing: entry.cost.tieredPricing } : {}),
    },
    contextWindow: entry.contextWindow,
    ...(entry.contextTokens !== undefined ? { contextTokens: entry.contextTokens } : {}),
    maxTokens: entry.maxTokens,
    ...(entry.compat ? { compat: { ...entry.compat } } : {}),
  });
}

function staticNearAIModelDefinitions(): ModelDefinitionConfig[] {
  return NEARAI_MODEL_CATALOG.map(buildNearAIModelDefinition);
}

function hasRetryableNetworkCode(err: unknown): boolean {
  const queue: unknown[] = [err];
  const seen = new Set<unknown>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) {
      continue;
    }
    seen.add(current);
    const candidate = current as {
      cause?: unknown;
      errors?: unknown;
      code?: unknown;
      errno?: unknown;
    };
    const code =
      typeof candidate.code === "string"
        ? candidate.code
        : typeof candidate.errno === "string"
          ? candidate.errno
          : undefined;
    if (code && NEARAI_DISCOVERY_RETRYABLE_NETWORK_CODES.has(code)) {
      return true;
    }
    if (candidate.cause) {
      queue.push(candidate.cause);
    }
    if (Array.isArray(candidate.errors)) {
      queue.push(...candidate.errors);
    }
  }
  return false;
}

function isRetryableNearAIDiscoveryError(err: unknown): boolean {
  if (err instanceof NearAIDiscoveryHttpError) {
    return true;
  }
  if (err instanceof Error && err.name === "AbortError") {
    return true;
  }
  if (err instanceof TypeError && normalizeLowercaseStringOrEmpty(err.message) === "fetch failed") {
    return true;
  }
  return hasRetryableNetworkCode(err);
}

function normalizePositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function usdPerMillionTokens(cost: NearAICost | undefined): number {
  if (
    !cost ||
    typeof cost.amount !== "number" ||
    typeof cost.scale !== "number" ||
    !Number.isFinite(cost.amount) ||
    !Number.isFinite(cost.scale)
  ) {
    return 0;
  }
  return Number((cost.amount * 10 ** (6 - cost.scale)).toPrecision(12));
}

function resolveModelInput(metadata: NearAIModelMetadata | undefined): Array<"text" | "image"> {
  const input = normalizeStringList(metadata?.architecture?.inputModalities).filter(
    (item): item is "text" | "image" => item === "text" || item === "image",
  );
  return input.length > 0 ? [...new Set(input)] : ["text"];
}

function outputSupportsText(metadata: NearAIModelMetadata | undefined): boolean {
  const output = normalizeStringList(metadata?.architecture?.outputModalities);
  return output.length === 0 || output.includes("text");
}

function shouldSkipNearAIModel(modelId: string): boolean {
  const lower = normalizeLowercaseStringOrEmpty(modelId);
  return (
    lower === "openai/privacy-filter" ||
    lower.includes("embedding") ||
    lower.includes("reranker") ||
    lower.includes("whisper") ||
    lower.includes("flux")
  );
}

function resolveNearAIReasoning(model: NearAIModel, modelId: string): boolean {
  const text = [
    modelId,
    typeof model.metadata?.modelDisplayName === "string" ? model.metadata.modelDisplayName : "",
    typeof model.metadata?.modelDescription === "string" ? model.metadata.modelDescription : "",
  ]
    .join(" ")
    .toLowerCase();
  return /\breason|\bthinking|gpt-5|\bo3\b|\bo4\b|\bopus\b|\bsonnet\b|\bgemini\b|\bglm\b|qwen3\.5|qwen3\.6/.test(
    text,
  );
}

function buildNearAIModelDefinitionFromApi(model: NearAIModel): ModelDefinitionConfig | undefined {
  if (typeof model.modelId !== "string" || !model.modelId.trim()) {
    return undefined;
  }
  const modelId = model.modelId.trim();
  if (shouldSkipNearAIModel(modelId) || !outputSupportsText(model.metadata)) {
    return undefined;
  }
  const contextWindow =
    normalizePositiveInt(model.metadata?.contextLength) ?? NEARAI_DEFAULT_CONTEXT_WINDOW;
  const name =
    typeof model.metadata?.modelDisplayName === "string" && model.metadata.modelDisplayName.trim()
      ? model.metadata.modelDisplayName.trim()
      : modelId;
  const definition: ModelDefinitionConfig = {
    id: modelId,
    name,
    reasoning: resolveNearAIReasoning(model, modelId),
    input: resolveModelInput(model.metadata),
    cost: {
      input: usdPerMillionTokens(model.inputCostPerToken),
      output: usdPerMillionTokens(model.outputCostPerToken),
      cacheRead: usdPerMillionTokens(model.cacheReadCostPerToken),
      cacheWrite: 0,
    },
    contextWindow,
    maxTokens: Math.min(contextWindow, NEARAI_DISCOVERY_MAX_TOKENS),
  };
  return applyNearAIModelCompat(definition);
}

type NearAIModelDiscoveryOptions = {
  retryDelayMs?: number;
};

export async function discoverNearAIModels(
  options: NearAIModelDiscoveryOptions = {},
): Promise<ModelDefinitionConfig[]> {
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return staticNearAIModelDefinitions();
  }

  try {
    const { response, release } = await retryAsync(
      async () => {
        const result = await fetchWithSsrFGuard({
          url: NEARAI_MODEL_LIST_URL,
          signal: AbortSignal.timeout(NEARAI_DISCOVERY_TIMEOUT_MS),
          init: {
            headers: {
              Accept: "application/json",
            },
          },
          policy: { allowedHostnames: NEARAI_ALLOWED_HOSTNAMES },
          auditContext: "nearai-model-discovery",
        });
        const currentResponse = result.response;
        if (
          !currentResponse.ok &&
          NEARAI_DISCOVERY_RETRYABLE_HTTP_STATUS.has(currentResponse.status)
        ) {
          await result.release();
          throw new NearAIDiscoveryHttpError(currentResponse.status);
        }
        return result;
      },
      {
        attempts: 3,
        minDelayMs: options.retryDelayMs ?? 300,
        maxDelayMs: options.retryDelayMs ?? 2000,
        jitter: options.retryDelayMs === undefined ? 0.2 : 0,
        label: "nearai-model-discovery",
        shouldRetry: isRetryableNearAIDiscoveryError,
      },
    );

    try {
      if (!response.ok) {
        log.warn(`Failed to discover models: HTTP ${response.status}, using static catalog`);
        return staticNearAIModelDefinitions();
      }

      const data = (await response.json()) as NearAIModelsResponse;
      if (!Array.isArray(data.models) || data.models.length === 0) {
        log.warn("No models found from API, using static catalog");
        return staticNearAIModelDefinitions();
      }

      const models = data.models
        .map((row) => buildNearAIModelDefinitionFromApi(row as NearAIModel))
        .filter((row): row is ModelDefinitionConfig => row !== undefined);

      return models.length > 0 ? models : staticNearAIModelDefinitions();
    } finally {
      await release();
    }
  } catch (error) {
    if (error instanceof NearAIDiscoveryHttpError) {
      log.warn(`Failed to discover models: HTTP ${error.status}, using static catalog`);
      return staticNearAIModelDefinitions();
    }
    log.warn(`Discovery failed: ${String(error)}, using static catalog`);
    return staticNearAIModelDefinitions();
  }
}
