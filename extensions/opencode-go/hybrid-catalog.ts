// Hybrid OpenCode Go catalog: gateway IDs + models.dev metadata + static policy.
import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import {
  getCachedLiveProviderModelRows,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { getCachedLiveCatalogValue } from "openclaw/plugin-sdk/provider-catalog-shared";
import { normalizeModelCompat } from "openclaw/plugin-sdk/provider-model-shared";
import type {
  ModelApi,
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";

export const MODELS_DEV_API_URL = "https://models.dev/api.json";
export const MODELS_DEV_TIMEOUT_MS = 15_000;
/** Process-lifetime sticky after a successful fetch (not a short discovery TTL). */
export const PROCESS_STICKY_TTL_MS = 365 * 24 * 60 * 60 * 1000;

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

type ModelsDevModelRow = {
  id?: unknown;
  name?: unknown;
  reasoning?: unknown;
  modalities?: { input?: unknown };
  limit?: { context?: unknown; output?: unknown };
  cost?: {
    input?: unknown;
    output?: unknown;
    cache_read?: unknown;
    cache_write?: unknown;
    tiers?: unknown;
    context_over_200k?: {
      input?: unknown;
      output?: unknown;
      cache_read?: unknown;
      cache_write?: unknown;
    };
  };
  provider?: { npm?: unknown };
};

type ModelsDevProviderSlice = ReadonlyMap<string, ModelsDevModelRow>;

type HybridModelDefinition = ModelDefinitionConfig & {
  provider: string;
  api: NonNullable<ModelDefinitionConfig["api"]>;
  baseUrl: string;
  input: Array<"text" | "image">;
};

type HybridTransport = {
  api: ModelApi;
  baseUrl: string;
};

let lastHybridModelsById: Map<string, HybridModelDefinition> | null = null;

export function clearOpencodeGoHybridCatalogStateForTests(): void {
  lastHybridModelsById = null;
}

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function readNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function formatModelName(modelId: string): string {
  return modelId
    .split("-")
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(" ");
}

function mapModelsDevCost(
  cost: ModelsDevModelRow["cost"],
): ModelDefinitionConfig["cost"] | undefined {
  if (!cost || typeof cost !== "object") {
    return undefined;
  }
  const input = readNonNegativeNumber(cost.input);
  const output = readNonNegativeNumber(cost.output);
  if (input === undefined || output === undefined) {
    return undefined;
  }
  const cacheRead = readNonNegativeNumber(cost.cache_read) ?? 0;
  const cacheWrite = readNonNegativeNumber(cost.cache_write) ?? 0;
  const base = { input, output, cacheRead, cacheWrite };
  const tiers = Array.isArray(cost.tiers) ? cost.tiers : [];
  const mappedTiers: NonNullable<ModelDefinitionConfig["cost"]["tieredPricing"]> = [];
  for (const tier of tiers) {
    if (!tier || typeof tier !== "object" || Array.isArray(tier)) {
      continue;
    }
    const tierRecord = tier as {
      input?: unknown;
      output?: unknown;
      cache_read?: unknown;
      cache_write?: unknown;
      tier?: { type?: unknown; size?: unknown };
    };
    const tierInput = readNonNegativeNumber(tierRecord.input);
    const tierOutput = readNonNegativeNumber(tierRecord.output);
    const size = readPositiveNumber(tierRecord.tier?.size);
    if (tierInput === undefined || tierOutput === undefined || size === undefined) {
      continue;
    }
    if (mappedTiers.length === 0) {
      mappedTiers.push({ ...base, range: [0, size] });
    }
    mappedTiers.push({
      input: tierInput,
      output: tierOutput,
      cacheRead: readNonNegativeNumber(tierRecord.cache_read) ?? 0,
      cacheWrite: readNonNegativeNumber(tierRecord.cache_write) ?? 0,
      range: [size],
    });
  }
  if (mappedTiers.length > 0) {
    return { ...base, tieredPricing: mappedTiers };
  }
  const over = cost.context_over_200k;
  if (over && typeof over === "object") {
    const overInput = readNonNegativeNumber(over.input);
    const overOutput = readNonNegativeNumber(over.output);
    if (overInput !== undefined && overOutput !== undefined) {
      return {
        ...base,
        tieredPricing: [
          { ...base, range: [0, 200_000] },
          {
            input: overInput,
            output: overOutput,
            cacheRead: readNonNegativeNumber(over.cache_read) ?? 0,
            cacheWrite: readNonNegativeNumber(over.cache_write) ?? 0,
            range: [200_000],
          },
        ],
      };
    }
  }
  return base;
}

function mapModelsDevInput(modalities: ModelsDevModelRow["modalities"]): Array<"text" | "image"> {
  const raw = modalities?.input;
  if (!Array.isArray(raw)) {
    return ["text"];
  }
  return raw.includes("image") ? ["text", "image"] : ["text"];
}

function mapNpmToApi(npm: string | undefined): ModelApi | undefined {
  if (!npm) {
    return undefined;
  }
  if (npm.includes("anthropic")) {
    return "anthropic-messages";
  }
  if (npm.includes("google")) {
    return "google-generative-ai";
  }
  if (npm.includes("openai")) {
    return "openai-completions";
  }
  return undefined;
}

export function parseModelsDevProviderSlice(
  document: unknown,
  providerKey: string,
): ModelsDevProviderSlice {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return new Map();
  }
  const provider = (document as Record<string, unknown>)[providerKey];
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
    return new Map();
  }
  const models = (provider as { models?: unknown }).models;
  if (!models || typeof models !== "object" || Array.isArray(models)) {
    return new Map();
  }
  const slice = new Map<string, ModelsDevModelRow>();
  for (const [rawId, row] of Object.entries(models as Record<string, unknown>)) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      continue;
    }
    const id = readString((row as ModelsDevModelRow).id) ?? rawId;
    const normalizedId = id.trim().toLowerCase();
    if (!normalizedId) {
      continue;
    }
    slice.set(normalizedId, row as ModelsDevModelRow);
  }
  return slice;
}

async function fetchModelsDevProviderSlice(params: {
  providerKey: string;
  fetchGuard?: LiveModelCatalogFetchGuard;
  signal?: AbortSignal;
  fetchModelsDev?: () => Promise<unknown>;
}): Promise<ModelsDevProviderSlice> {
  try {
    if (params.fetchModelsDev) {
      const document = await getCachedLiveCatalogValue({
        keyParts: ["models.dev", "api.json", "injected", PROVIDER_ID],
        ttlMs: PROCESS_STICKY_TTL_MS,
        shouldCache: (value) => value !== null && typeof value === "object",
        load: params.fetchModelsDev,
      });
      return parseModelsDevProviderSlice(document, params.providerKey);
    }
    const rows = await getCachedLiveProviderModelRows({
      providerId: "models-dev",
      endpoint: MODELS_DEV_API_URL,
      fetchGuard: params.fetchGuard,
      signal: params.signal,
      timeoutMs: MODELS_DEV_TIMEOUT_MS,
      ttlMs: PROCESS_STICKY_TTL_MS,
      auditContext: "models-dev-catalog",
      cacheKeyParts: ["models.dev", "api.json"],
      readRows: (body) => [body],
      shouldCacheRows: (modelRows) => modelRows.length > 0,
    });
    return parseModelsDevProviderSlice(rows[0], params.providerKey);
  } catch {
    return new Map();
  }
}

function readLiveModelId(row: unknown): string | undefined {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return undefined;
  }
  const candidate = row as { id?: unknown; object?: unknown };
  if (candidate.object !== undefined && candidate.object !== "model") {
    return undefined;
  }
  if (typeof candidate.id !== "string") {
    return undefined;
  }
  const modelId = candidate.id.trim().toLowerCase();
  return modelId || undefined;
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

function mapModelsDevRowToModel(params: {
  modelId: string;
  row: ModelsDevModelRow;
  resolveTransport: (modelId: string) => HybridTransport;
  staticBase?: HybridModelDefinition;
}): HybridModelDefinition {
  const transport = params.resolveTransport(params.modelId);
  const npmApi = mapNpmToApi(readString(params.row.provider?.npm));
  const api = transport.api !== "openai-completions" || !npmApi ? transport.api : npmApi;
  const cost = mapModelsDevCost(params.row.cost) ??
    params.staticBase?.cost ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    };
  const contextWindow =
    readPositiveNumber(params.row.limit?.context) ?? params.staticBase?.contextWindow ?? 128_000;
  const maxTokens =
    readPositiveNumber(params.row.limit?.output) ?? params.staticBase?.maxTokens ?? 8_192;
  const name =
    readString(params.row.name) ?? params.staticBase?.name ?? formatModelName(params.modelId);
  const reasoning =
    typeof params.row.reasoning === "boolean"
      ? params.row.reasoning
      : (params.staticBase?.reasoning ?? true);
  const input =
    params.row.modalities?.input !== undefined
      ? mapModelsDevInput(params.row.modalities)
      : (params.staticBase?.input ?? ["text"]);
  const mapped = normalizeModelCompat({
    id: params.modelId,
    name,
    api,
    provider: PROVIDER_ID,
    baseUrl: transport.baseUrl,
    reasoning,
    input,
    cost,
    contextWindow,
    maxTokens,
    compat: {
      supportsUsageInStreaming: true,
      supportsReasoningEffort: reasoning,
      maxTokensField: "max_tokens",
      ...(params.staticBase?.compat ?? {}),
    },
    ...(params.staticBase?.thinkingLevelMap
      ? { thinkingLevelMap: params.staticBase.thinkingLevelMap }
      : {}),
  }) as HybridModelDefinition;
  return applyOpencodeGoPolicyOverlay(mapped, params.staticBase);
}

export function buildHybridModelDefinitions(params: {
  gatewayIds: readonly string[];
  modelsDev: ModelsDevProviderSlice;
  staticModels: readonly HybridModelDefinition[];
  resolveTransport: (modelId: string) => HybridTransport;
}): HybridModelDefinition[] {
  const staticById = new Map(params.staticModels.map((model) => [model.id, model]));
  const models: HybridModelDefinition[] = [];
  for (const rawId of params.gatewayIds) {
    const modelId = rawId.trim().toLowerCase();
    if (!modelId || DEPRECATED_GATEWAY_IDS.has(modelId)) {
      continue;
    }
    const md = params.modelsDev.get(modelId);
    const base = staticById.get(modelId);
    if (md) {
      models.push(
        mapModelsDevRowToModel({
          modelId,
          row: md,
          resolveTransport: params.resolveTransport,
          staticBase: base,
        }),
      );
      continue;
    }
    if (base) {
      models.push(base);
    }
  }
  return models;
}

async function fetchGatewayModelIds(params: {
  gatewayEndpoint: string;
  gatewayTimeoutMs: number;
  apiKey?: string;
  discoveryApiKey?: string;
  fetchGuard?: LiveModelCatalogFetchGuard;
  signal?: AbortSignal;
}): Promise<string[]> {
  const rows = await getCachedLiveProviderModelRows({
    providerId: PROVIDER_ID,
    endpoint: params.gatewayEndpoint,
    apiKey: params.apiKey,
    discoveryApiKey: params.discoveryApiKey,
    fetchGuard: params.fetchGuard,
    signal: params.signal,
    timeoutMs: params.gatewayTimeoutMs,
    ttlMs: PROCESS_STICKY_TTL_MS,
    auditContext: "opencode-go-model-discovery",
    cacheKeyParts: [
      PROVIDER_ID,
      "gateway-model-ids",
      params.gatewayEndpoint,
      params.discoveryApiKey ?? params.apiKey,
    ],
  });
  const seen = new Set<string>();
  const modelIds: string[] = [];
  for (const row of rows) {
    const modelId = readLiveModelId(row);
    if (!modelId || seen.has(modelId) || DEPRECATED_GATEWAY_IDS.has(modelId)) {
      continue;
    }
    seen.add(modelId);
    modelIds.push(modelId);
  }
  return modelIds;
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
}): Promise<ModelProviderConfig> {
  const fallbackModels = params.staticModels;
  const buildProvider = (models: readonly HybridModelDefinition[]): ModelProviderConfig => ({
    api: "openai-completions",
    baseUrl: params.openaiBaseUrl,
    ...(params.apiKey ? { apiKey: params.apiKey } : {}),
    models: [...models],
  });
  const resolveTransport = (modelId: string) =>
    resolveOpencodeGoFamilyTransport(modelId, params.openaiBaseUrl, params.anthropicBaseUrl);

  try {
    const hybridModels = await getCachedLiveCatalogValue({
      keyParts: [
        PROVIDER_ID,
        "hybrid-catalog",
        params.discoveryApiKey ?? params.apiKey,
        params.gatewayEndpoint,
      ],
      ttlMs: PROCESS_STICKY_TTL_MS,
      shouldCache: (models) => models.length > 0,
      load: async () => {
        const [gatewayIds, modelsDev] = await Promise.all([
          fetchGatewayModelIds({
            gatewayEndpoint: params.gatewayEndpoint,
            gatewayTimeoutMs: params.gatewayTimeoutMs,
            apiKey: params.apiKey,
            discoveryApiKey: params.discoveryApiKey,
            fetchGuard: params.fetchGuard,
            signal: params.signal,
          }),
          fetchModelsDevProviderSlice({
            providerKey: MODELS_DEV_PROVIDER_KEY,
            fetchGuard: params.fetchGuard,
            signal: params.signal,
            fetchModelsDev: params.fetchModelsDev,
          }),
        ]);
        if (gatewayIds.length === 0) {
          return [...fallbackModels];
        }
        const built = buildHybridModelDefinitions({
          gatewayIds,
          modelsDev,
          staticModels: fallbackModels,
          resolveTransport,
        });
        return built.length > 0 ? built : [...fallbackModels];
      },
    });
    if (hybridModels.length > 0) {
      lastHybridModelsById = new Map(hybridModels.map((model) => [model.id, model]));
      return buildProvider(hybridModels);
    }
  } catch {
    // Hybrid discovery is advisory; keep the provider-owned static seed visible.
  }
  lastHybridModelsById = new Map(fallbackModels.map((model) => [model.id, model]));
  return buildProvider(fallbackModels);
}

export function resolveHybridDynamicModel(
  modelId: string,
  staticModels: readonly HybridModelDefinition[],
): ProviderRuntimeModel | undefined {
  const normalizedModelId = modelId.trim().toLowerCase();
  const hybrid = lastHybridModelsById?.get(normalizedModelId);
  if (hybrid) {
    return hybrid;
  }
  return staticModels.find((model) => model.id === normalizedModelId);
}

export async function prewarmOpencodeGoHybridCatalog(): Promise<void> {
  try {
    await fetchModelsDevProviderSlice({ providerKey: MODELS_DEV_PROVIDER_KEY });
  } catch {
    // Prewarm is best-effort.
  }
}
