// Novita provider module implements model/runtime integration.
import {
  getCachedLiveProviderModelRows,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import {
  buildSingleProviderApiKeyCatalog,
  type ProviderCatalogContext,
  type ProviderCatalogResult,
} from "openclaw/plugin-sdk/provider-catalog-shared";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import { NOVITA_BASE_URL, NOVITA_MODEL_CATALOG, buildNovitaModelDefinition } from "./models.js";

const PROVIDER_ID = "novita";
export const NOVITA_MODELS_URL = `${NOVITA_BASE_URL}/models`;

const NOVITA_DISCOVERY_TIMEOUT_MS = 5_000;
const NOVITA_DISCOVERY_CACHE_TTL_MS = 5 * 60 * 1000;
const NOVITA_DEFAULT_CONTEXT_WINDOW = 128_000;
const NOVITA_DEFAULT_MAX_TOKENS = 65_536;
const NOVITA_MAX_MODEL_ID_LENGTH = 200;
const NOVITA_MAX_CONTEXT_WINDOW = 10_000_000;
const NOVITA_DEFAULT_COST: ModelDefinitionConfig["cost"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readPositiveSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= NOVITA_MAX_CONTEXT_WINDOW
    ? value
    : undefined;
}

function hasUnsafeModelIdChars(id: string): boolean {
  if (/\s/u.test(id)) {
    return true;
  }
  for (const ch of id) {
    const code = ch.codePointAt(0) ?? 0;
    // Reject C0 control chars and DEL without a control-char regex literal.
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function buildNovitaModelDefinitionFromLiveRow(row: unknown): ModelDefinitionConfig | undefined {
  const entry = readRecord(row);
  const id = readString(entry?.id);
  if (!id || id.length > NOVITA_MAX_MODEL_ID_LENGTH || hasUnsafeModelIdChars(id)) {
    return undefined;
  }
  const contextWindow =
    readPositiveSafeInteger(entry?.context_size) ?? NOVITA_DEFAULT_CONTEXT_WINDOW;
  // The list endpoint does not advertise modality, reasoning, or output limits.
  // Keep unknown routes conservative instead of inferring capabilities from their names.
  return {
    id,
    name: readString(entry?.title) ?? id,
    api: "openai-completions",
    reasoning: false,
    input: ["text"],
    cost: { ...NOVITA_DEFAULT_COST },
    contextWindow,
    maxTokens: Math.min(contextWindow, NOVITA_DEFAULT_MAX_TOKENS),
  };
}

function readNovitaModelRows(body: unknown): readonly unknown[] {
  const data = readRecord(body)?.data;
  if (!Array.isArray(data)) {
    throw new Error("Novita model discovery response must contain data[]");
  }
  return data;
}

function hasUsableNovitaModelRows(rows: readonly unknown[]): boolean {
  return rows.some((row) => buildNovitaModelDefinitionFromLiveRow(row) !== undefined);
}

function hasCustomNovitaBaseUrl(config: ProviderCatalogContext["config"] | undefined): boolean {
  const novitaProviderIds = new Set([PROVIDER_ID, "novita-ai", "novitaai"]);
  for (const [providerId, provider] of Object.entries(config?.models?.providers ?? {})) {
    if (!novitaProviderIds.has(providerId.trim().toLowerCase())) {
      continue;
    }
    const baseUrl = readString(readRecord(provider)?.baseUrl);
    if (baseUrl && baseUrl !== NOVITA_BASE_URL) {
      return true;
    }
  }
  return false;
}

export function resolveNovitaDiscoveryApiKey(ctx: {
  config?: ProviderCatalogContext["config"];
  resolveProviderApiKey?: ProviderCatalogContext["resolveProviderApiKey"];
}): string | undefined {
  // The augment-catalog context may omit config or the key resolver; without
  // both there is nothing to discover against, so fall back to static rows.
  if (!ctx.resolveProviderApiKey) {
    return undefined;
  }
  // A custom endpoint may not implement Novita's model-list contract. Never send
  // its credential to the public Novita endpoint; configured models remain available.
  if (hasCustomNovitaBaseUrl(ctx.config)) {
    return undefined;
  }
  return ctx.resolveProviderApiKey(PROVIDER_ID).discoveryApiKey;
}

export function buildStaticNovitaProvider(): ModelProviderConfig {
  return {
    baseUrl: NOVITA_BASE_URL,
    api: "openai-completions",
    models: NOVITA_MODEL_CATALOG.map(buildNovitaModelDefinition),
  };
}

export async function buildNovitaProvider(
  params: {
    discoveryApiKey?: string;
    fetchGuard?: LiveModelCatalogFetchGuard;
  } = {},
): Promise<ModelProviderConfig> {
  const fallback = buildStaticNovitaProvider();
  if (!params.discoveryApiKey?.trim()) {
    return fallback;
  }
  try {
    const rows = await getCachedLiveProviderModelRows({
      providerId: PROVIDER_ID,
      endpoint: NOVITA_MODELS_URL,
      discoveryApiKey: params.discoveryApiKey,
      fetchGuard: params.fetchGuard,
      timeoutMs: NOVITA_DISCOVERY_TIMEOUT_MS,
      ttlMs: NOVITA_DISCOVERY_CACHE_TTL_MS,
      auditContext: "novita-model-discovery",
      readRows: readNovitaModelRows,
      shouldCacheRows: hasUsableNovitaModelRows,
      buildRequestHeaders: ({ discoveryApiKey }) => ({
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(discoveryApiKey ? { Authorization: `Bearer ${discoveryApiKey}` } : {}),
      }),
    });
    // Preserve curated static metadata (reasoning, vision, context, pricing)
    // for models the manifest already knows; the live list endpoint only carries
    // an id/title/context, so conservative synthesis is used for new routes only.
    const staticById = new Map(fallback.models.map((model) => [model.id, model]));
    const models = new Map<string, ModelDefinitionConfig>();
    for (const row of rows) {
      const discovered = buildNovitaModelDefinitionFromLiveRow(row);
      if (!discovered || models.has(discovered.id)) {
        continue;
      }
      models.set(discovered.id, staticById.get(discovered.id) ?? discovered);
    }
    if (models.size > 0) {
      return {
        ...fallback,
        models: [...models.values()].toSorted((left, right) => left.id.localeCompare(right.id)),
      };
    }
  } catch {
    // The manifest catalog remains the offline/auth-failure fallback.
  }
  return fallback;
}

export function buildNovitaApiKeyCatalog(
  ctx: ProviderCatalogContext,
): Promise<ProviderCatalogResult> {
  const discoveryApiKey = resolveNovitaDiscoveryApiKey(ctx);
  return buildSingleProviderApiKeyCatalog({
    ctx,
    providerId: PROVIDER_ID,
    allowExplicitBaseUrl: true,
    buildProvider: () => buildNovitaProvider({ discoveryApiKey }),
  });
}
