import type { ModelCatalogEntry } from "openclaw/plugin-sdk/agent-runtime";
import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import {
  createUpstreamProviderCatalog,
  fetchLiveProviderModelIds,
  listProviderCatalogSnapshotEntries,
  type LiveModelCatalogFetchGuard,
  type ProviderCatalogSnapshot,
  type ProjectedUpstreamProviderCatalogModel as OpencodeZenModelDefinition,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { normalizeModelCompat } from "openclaw/plugin-sdk/provider-model-shared";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const PROVIDER_ID = "opencode";
const OPENCODE_ZEN_OPENAI_BASE_URL = "https://opencode.ai/zen/v1";
const OPENCODE_ZEN_ANTHROPIC_BASE_URL = "https://opencode.ai/zen";
const OPENCODE_ZEN_MODELS_ENDPOINT = "https://opencode.ai/zen/v1/models";
const OPENCODE_UPSTREAM_CATALOG_ENDPOINT = "https://models.opencode.ai/api.json";
const OPENCODE_ZEN_MODELS_TIMEOUT_MS = 5_000;
const OPENCODE_ZEN_MODELS_CACHE_TTL_MS = 60_000;

type FetchOpencodeZenLiveModelIdsParams = {
  apiKey?: string;
  discoveryApiKey?: string;
  fetchGuard?: LiveModelCatalogFetchGuard;
  signal?: AbortSignal;
};

const OPENCODE_ZEN_MANIFEST_PROVIDER = manifest.modelCatalog.providers.opencode;
const OPENCODE_ZEN_SEED_CATALOG: ProviderCatalogSnapshot = new Map(
  OPENCODE_ZEN_MANIFEST_PROVIDER.models.map((row) => {
    // SAFETY: Bundled rows and inherited transport supply the complete runtime model shape.
    const model = normalizeModelCompat({
      ...row,
      provider: PROVIDER_ID,
      api: row.api ?? OPENCODE_ZEN_MANIFEST_PROVIDER.api,
      baseUrl: row.baseUrl ?? OPENCODE_ZEN_MANIFEST_PROVIDER.baseUrl,
    } as OpencodeZenModelDefinition) as OpencodeZenModelDefinition;
    return [
      model.id,
      {
        model,
        ...("status" in row && row.status === "deprecated"
          ? { status: "deprecated" as const }
          : {}),
        ...("replacedBy" in row && typeof row.replacedBy === "string"
          ? { replacedBy: row.replacedBy }
          : {}),
      },
    ];
  }),
);
const opencodeZenCatalog = createUpstreamProviderCatalog({
  providerId: PROVIDER_ID,
  seed: OPENCODE_ZEN_SEED_CATALOG,
  // Zen refreshes lifecycle entirely from upstream; Go retains omitted seed lifecycle.
  upstreamSeed: new Map(
    Array.from(OPENCODE_ZEN_SEED_CATALOG, ([id, { model }]) => [id, { model }]),
  ),
  providerConfig: { api: "openai-completions", baseUrl: OPENCODE_ZEN_OPENAI_BASE_URL },
  metadataEndpoint: OPENCODE_UPSTREAM_CATALOG_ENDPOINT,
  modelsEndpoint: OPENCODE_ZEN_MODELS_ENDPOINT,
  anthropicBaseUrl: OPENCODE_ZEN_ANTHROPIC_BASE_URL,
  timeoutMs: OPENCODE_ZEN_MODELS_TIMEOUT_MS,
  ttlMs: OPENCODE_ZEN_MODELS_CACHE_TTL_MS,
  auditContext: "opencode-zen-model-discovery",
  isStaticEntryActive: (entry) => entry?.status !== "deprecated",
});

export async function prepareOpencodeZenModel(params: {
  modelId: string;
  fetchGuard?: LiveModelCatalogFetchGuard;
  signal?: AbortSignal;
}): Promise<ProviderRuntimeModel | undefined> {
  const snapshot = await opencodeZenCatalog.refreshMetadata(params);
  return snapshot?.get(params.modelId.trim().toLowerCase())?.model;
}

export function buildStaticOpencodeZenProviderConfig(apiKey?: string): ModelProviderConfig {
  return opencodeZenCatalog.buildStaticProvider(apiKey);
}

export async function resolveOpencodeZenStarterModel(params: {
  apiKey: string;
  preferredModelRef: string;
  fetchGuard?: LiveModelCatalogFetchGuard;
  signal?: AbortSignal;
}): Promise<string | undefined> {
  const liveModelIds = await fetchLiveProviderModelIds({
    providerId: PROVIDER_ID,
    endpoint: OPENCODE_ZEN_MODELS_ENDPOINT,
    discoveryApiKey: params.apiKey,
    fetchGuard: params.fetchGuard,
    signal: params.signal,
    timeoutMs: OPENCODE_ZEN_MODELS_TIMEOUT_MS,
    auditContext: "opencode-zen-onboarding-model-discovery",
  });
  const preferredModelId = params.preferredModelRef.replace(`${PROVIDER_ID}/`, "");
  return liveModelIds.includes(preferredModelId) ? params.preferredModelRef : undefined;
}

export async function buildOpencodeZenLiveProviderConfig(
  params: FetchOpencodeZenLiveModelIdsParams = {},
): Promise<ModelProviderConfig> {
  return await opencodeZenCatalog.buildLiveProvider(params);
}

export function listOpencodeZenModelCatalogEntries(): ModelCatalogEntry[] {
  return listProviderCatalogSnapshotEntries(opencodeZenCatalog.getSnapshot());
}

export function resolveOpencodeZenModel(modelId: string): ProviderRuntimeModel | undefined {
  return opencodeZenCatalog.getSnapshot().get(modelId.trim().toLowerCase())?.model;
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl ?? "").trim().replace(/\/+$/, "");
}

export function normalizeOpencodeZenBaseUrl(params: {
  api?: string | null;
  baseUrl?: string;
}): string | undefined {
  const normalized = normalizeBaseUrl(params.baseUrl);
  if (!normalized) {
    return undefined;
  }
  const isAnthropicRoute = params.api === "anthropic-messages";
  if (normalized === OPENCODE_ZEN_ANTHROPIC_BASE_URL) {
    return isAnthropicRoute ? OPENCODE_ZEN_ANTHROPIC_BASE_URL : OPENCODE_ZEN_OPENAI_BASE_URL;
  }
  if (normalized === OPENCODE_ZEN_OPENAI_BASE_URL) {
    return isAnthropicRoute ? OPENCODE_ZEN_ANTHROPIC_BASE_URL : OPENCODE_ZEN_OPENAI_BASE_URL;
  }
  return undefined;
}
