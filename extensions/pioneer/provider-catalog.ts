// Pioneer provider module implements model/runtime integration.
import {
  getCachedLiveProviderModelRows,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type {
  ProviderCatalogContext,
  ProviderCatalogResult,
} from "openclaw/plugin-sdk/provider-catalog-shared";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { buildPioneerModelDefinition, PIONEER_BASE_URL, PIONEER_MODEL_CATALOG } from "./models.js";

const PROVIDER_ID = "pioneer";
const PIONEER_MODELS_ENDPOINT = `${PIONEER_BASE_URL}/models`;
const PIONEER_MODELS_CACHE_TTL_MS = 60_000;
const PIONEER_UNKNOWN_MODEL_CONTEXT_WINDOW = 128_000;
const PIONEER_UNKNOWN_MODEL_MAX_TOKENS = 16_384;
const PIONEER_UNKNOWN_MODEL_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} satisfies ModelDefinitionConfig["cost"];
// No longer needed: ID normalization happens in normalizePioneerLiveModelId.
const PIONEER_LIVE_MODEL_METADATA_PREFIXES: readonly string[] = [];
const PIONEER_LIVE_CONTEXT_KEYS = [
  "contextWindow",
  "context_window",
  "contextLength",
  "context_length",
  "maxContextLength",
  "max_context_length",
  "maxContextTokens",
  "max_context_tokens",
  "max_input_tokens",
  "maxInputTokens",
] as const;
const PIONEER_LIVE_MAX_TOKENS_KEYS = [
  "maxTokens",
  "max_tokens",
  "maxOutputTokens",
  "max_output_tokens",
  "maxCompletionTokens",
  "max_completion_tokens",
] as const;
const SUPPORTED_INPUT_MODALITIES = new Set(["text", "image", "audio", "video"]);

type PioneerCatalogConfig = {
  models?: {
    providers?: Record<string, { baseUrl?: unknown } | undefined>;
  };
};

function buildPioneerModels() {
  return PIONEER_MODEL_CATALOG.map(buildPioneerModelDefinition);
}

function trimTrailingSlashes(value: string) {
  return value.replace(/\/+$/, "");
}

function resolveConfiguredPioneerBaseUrl(config: PioneerCatalogConfig | undefined) {
  const provider = Object.entries(config?.models?.providers ?? {}).find(
    ([providerId]) => normalizeProviderId(providerId) === PROVIDER_ID,
  )?.[1];
  const baseUrl = normalizeOptionalString(provider?.baseUrl);
  if (!baseUrl || trimTrailingSlashes(baseUrl) === trimTrailingSlashes(PIONEER_BASE_URL)) {
    return undefined;
  }
  return baseUrl;
}

function readRecord(row: unknown): Record<string, unknown> | undefined {
  return row && typeof row === "object" && !Array.isArray(row)
    ? (row as Record<string, unknown>)
    : undefined;
}

function readLiveModelString(row: unknown, keys: readonly string[]): string | undefined {
  const record = readRecord(row);
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function readLiveModelPositiveInteger(row: unknown, keys: readonly string[]): number | undefined {
  const record = readRecord(row);
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
      return value;
    }
  }
  return undefined;
}

function readLiveModelBoolean(row: unknown, keys: readonly string[]): boolean | undefined {
  const record = readRecord(row);
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

function readLiveModelInput(row: unknown): ModelDefinitionConfig["input"] | undefined {
  const record = readRecord(row);
  if (!record) {
    return undefined;
  }
  const candidates = [
    record.input,
    record.inputs,
    record.modalities,
    record.inputModalities,
    record.input_modalities,
    readRecord(record.capabilities)?.input,
    readRecord(record.capabilities)?.inputs,
    readRecord(record.capabilities)?.modalities,
  ];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) {
      continue;
    }
    const input = candidate
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim().toLowerCase())
      .filter((value): value is ModelDefinitionConfig["input"][number] =>
        SUPPORTED_INPUT_MODALITIES.has(value),
      );
    if (input.length > 0) {
      return [...new Set(input)];
    }
  }
  return undefined;
}

// Pioneer API uses "anthropic/pioneer/" as a namespace for some model IDs.
// Strip this prefix so they don't double-prefix when OpenClaw adds the
// "pioneer/" provider namespace. "pioneer/auto" is kept as-is — the API
// requires the full prefix and the normalizeModelId hook handles transport.
function normalizePioneerLiveModelId(rawId: string): string {
  for (const prefix of ["anthropic/pioneer/", "pioneer/pioneer/"] as const) {
    if (rawId.startsWith(prefix)) {
      return rawId.slice(prefix.length);
    }
  }
  return rawId;
}

function readLiveModelId(row: unknown): string | undefined {
  const record = readRecord(row);
  if (!record) {
    return undefined;
  }
  if (record.object !== undefined && record.object !== "model") {
    return undefined;
  }
  const rawId = readLiveModelString(row, ["id"]);
  return rawId ? normalizePioneerLiveModelId(rawId) : undefined;
}

function resolveLiveModelMetadataFallback(
  modelId: string,
  staticModelsById: ReadonlyMap<string, ModelDefinitionConfig>,
): ModelDefinitionConfig | undefined {
  const exact = staticModelsById.get(modelId);
  if (exact) {
    return exact;
  }
  for (const prefix of PIONEER_LIVE_MODEL_METADATA_PREFIXES) {
    if (modelId.startsWith(prefix)) {
      const strippedModelId = modelId.slice(prefix.length);
      const fallback = staticModelsById.get(strippedModelId);
      if (fallback) {
        return fallback;
      }
    }
  }
  return undefined;
}

function buildLivePioneerModelDefinition(
  row: unknown,
  staticModelsById: ReadonlyMap<string, ModelDefinitionConfig>,
): ModelDefinitionConfig | undefined {
  const modelId = readLiveModelId(row);
  if (!modelId) {
    return undefined;
  }
  const fallback = resolveLiveModelMetadataFallback(modelId, staticModelsById);
  const rowName = readLiveModelString(row, ["name", "display_name", "title"]);
  if (fallback) {
    return {
      ...fallback,
      id: modelId,
      name: rowName ?? (fallback.id === modelId ? fallback.name : modelId),
      contextWindow:
        readLiveModelPositiveInteger(row, PIONEER_LIVE_CONTEXT_KEYS) ?? fallback.contextWindow,
      maxTokens:
        readLiveModelPositiveInteger(row, PIONEER_LIVE_MAX_TOKENS_KEYS) ?? fallback.maxTokens,
      input: readLiveModelInput(row) ?? fallback.input,
      reasoning:
        readLiveModelBoolean(row, [
          "reasoning",
          "supports_reasoning",
          "supportsReasoning",
          "thinking",
        ]) ?? fallback.reasoning,
    };
  }
  const contextWindow =
    readLiveModelPositiveInteger(row, PIONEER_LIVE_CONTEXT_KEYS) ??
    PIONEER_UNKNOWN_MODEL_CONTEXT_WINDOW;
  return {
    id: modelId,
    name: rowName ?? modelId,
    api: "openai-completions",
    reasoning:
      readLiveModelBoolean(row, [
        "reasoning",
        "supports_reasoning",
        "supportsReasoning",
        "thinking",
      ]) ?? false,
    input: readLiveModelInput(row) ?? ["text"],
    cost: { ...PIONEER_UNKNOWN_MODEL_COST },
    contextWindow,
    maxTokens:
      readLiveModelPositiveInteger(row, PIONEER_LIVE_MAX_TOKENS_KEYS) ??
      Math.min(contextWindow, PIONEER_UNKNOWN_MODEL_MAX_TOKENS),
  };
}

// Model IDs present in the static catalog but not returned by the live API —
// routing aliases that must always be available regardless of discovery results.
const PIONEER_STATIC_ONLY_MODEL_IDS = new Set(["pioneer/auto"]);

function buildPioneerModelsFromLiveRows(rows: readonly unknown[]): ModelDefinitionConfig[] {
  const staticModels = buildPioneerModels();
  const staticModelsById = new Map(staticModels.map((model) => [model.id, model]));
  const seen = new Set<string>();
  const models: ModelDefinitionConfig[] = [];
  // Prepend static-only routing aliases (e.g. pioneer/auto) so they survive
  // live catalog replacement and remain available as a default primary.
  for (const staticModel of staticModels) {
    if (PIONEER_STATIC_ONLY_MODEL_IDS.has(staticModel.id)) {
      seen.add(staticModel.id);
      models.push(staticModel);
    }
  }
  for (const row of rows) {
    const model = buildLivePioneerModelDefinition(row, staticModelsById);
    if (!model || seen.has(model.id)) {
      continue;
    }
    seen.add(model.id);
    models.push(model);
  }
  return models;
}

function buildPioneerProviderConfig(params: {
  models: ModelDefinitionConfig[];
  apiKey?: string;
  baseUrl?: string;
}): ModelProviderConfig {
  return {
    baseUrl: params.baseUrl ?? PIONEER_BASE_URL,
    api: "openai-completions",
    ...(params.apiKey ? { apiKey: params.apiKey } : {}),
    models: params.models,
  };
}

export function buildPioneerProvider(params: { apiKey?: string; baseUrl?: string } = {}) {
  return buildPioneerProviderConfig({
    models: buildPioneerModels(),
    apiKey: params.apiKey,
    baseUrl: params.baseUrl,
  });
}

export async function buildLivePioneerProvider(params: {
  apiKey?: string;
  discoveryApiKey?: string;
  fallbackDiscoveryApiKey?: string;
  fetchGuard?: LiveModelCatalogFetchGuard;
  signal?: AbortSignal;
}): Promise<ModelProviderConfig> {
  // Build an ordered list of discovery keys to try. When a key fails (e.g.
  // expired profile key), the next one is attempted so a valid env-var key
  // can still succeed. An undefined slot preserves the original path where
  // getCachedLiveProviderModelRows falls back to apiKey for auth.
  const discoveryKeys: Array<string | undefined> = params.discoveryApiKey
    ? [
        params.discoveryApiKey,
        ...(params.fallbackDiscoveryApiKey &&
        params.fallbackDiscoveryApiKey !== params.discoveryApiKey
          ? [params.fallbackDiscoveryApiKey]
          : []),
      ]
    : [undefined];
  for (const discoveryApiKey of discoveryKeys) {
    try {
      const rows = await getCachedLiveProviderModelRows({
        providerId: PROVIDER_ID,
        endpoint: PIONEER_MODELS_ENDPOINT,
        apiKey: params.apiKey,
        discoveryApiKey,
        fetchGuard: params.fetchGuard,
        signal: params.signal,
        ttlMs: PIONEER_MODELS_CACHE_TTL_MS,
        auditContext: "pioneer-model-discovery",
      });
      const models = buildPioneerModelsFromLiveRows(rows);
      if (models.length > 0) {
        return buildPioneerProviderConfig({
          models,
          apiKey: params.apiKey,
        });
      }
    } catch {
      // Pioneer discovery is advisory. Try next key if available.
    }
  }
  return buildPioneerProvider({ apiKey: params.apiKey });
}

export async function buildPioneerCatalogResult(
  ctx: ProviderCatalogContext,
): Promise<ProviderCatalogResult> {
  const auth = ctx.resolveProviderAuth(PROVIDER_ID);
  const envAuth = ctx.resolveProviderApiKey(PROVIDER_ID);
  const apiKey = auth.apiKey ?? envAuth.apiKey;
  if (!apiKey) {
    return null;
  }
  const explicitBaseUrl = resolveConfiguredPioneerBaseUrl(ctx.config);
  if (explicitBaseUrl) {
    return {
      provider: buildPioneerProvider({
        apiKey,
        baseUrl: explicitBaseUrl,
      }),
    };
  }
  // Try profile/auth discovery key first, then fall back to env var key.
  // A profile with an expired or invalid key should not block discovery via env.
  const primaryDiscovery = auth.discoveryApiKey;
  const envDiscovery = envAuth.discoveryApiKey;
  return {
    provider: await buildLivePioneerProvider({
      apiKey,
      discoveryApiKey: primaryDiscovery ?? envDiscovery,
      fallbackDiscoveryApiKey:
        primaryDiscovery && primaryDiscovery !== envDiscovery ? envDiscovery : undefined,
    }),
  };
}
