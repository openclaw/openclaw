import type { ModelCatalogEntry } from "openclaw/plugin-sdk/agent-runtime";
import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import {
  buildOpenAICompatibleLiveModels,
  createUpstreamProviderCatalog,
  listProviderCatalogSnapshotEntries,
  projectProviderCatalogSnapshotRows,
  type LiveModelCatalogFetchGuard,
  type ProviderCatalogSnapshot,
  type ProjectedUpstreamProviderCatalogModel as OpencodeZenModelDefinition,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { normalizeBaseUrl } from "openclaw/plugin-sdk/provider-http";
import { normalizeModelCompat } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const PROVIDER_ID = "opencode";
const OPENCODE_ZEN_OPENAI_BASE_URL = "https://opencode.ai/zen/v1";
const OPENCODE_ZEN_ANTHROPIC_BASE_URL = "https://opencode.ai/zen";
const OPENCODE_ZEN_MODELS_ENDPOINT = "https://opencode.ai/zen/v1/models";
const OPENCODE_UPSTREAM_CATALOG_ENDPOINT = "https://models.opencode.ai/api.json";
const OPENCODE_ZEN_MODELS_TIMEOUT_MS = 5_000;
const OPENCODE_ZEN_MODELS_CACHE_TTL_MS = 60_000;

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
const OPENCODE_ZEN_PROVIDER_ROUTE = {
  api: "openai-completions",
  baseUrl: OPENCODE_ZEN_OPENAI_BASE_URL,
} as const;
const opencodeZenCatalog = createUpstreamProviderCatalog({
  providerId: PROVIDER_ID,
  seed: OPENCODE_ZEN_SEED_CATALOG,
  // Zen refreshes lifecycle entirely from upstream; Go retains omitted seed lifecycle.
  upstreamSeed: new Map(
    Array.from(OPENCODE_ZEN_SEED_CATALOG, ([id, { model }]) => [id, { model }]),
  ),
  providerConfig: OPENCODE_ZEN_PROVIDER_ROUTE,
  projectRows: (rows, snapshot) => [
    ...projectProviderCatalogSnapshotRows(rows, snapshot),
    ...buildOpenAICompatibleLiveModels(rows, { ...OPENCODE_ZEN_PROVIDER_ROUTE, models: [] })
      .filter((model) => !snapshot.has(model.id.toLowerCase()))
      .map((model): OpencodeZenModelDefinition => {
        const input: OpencodeZenModelDefinition["input"] = model.input.includes("image")
          ? ["text", "image"]
          : ["text"];
        return Object.assign(model, OPENCODE_ZEN_PROVIDER_ROUTE, {
          provider: PROVIDER_ID,
          input,
        });
      }),
  ],
  metadataEndpoint: OPENCODE_UPSTREAM_CATALOG_ENDPOINT,
  modelsEndpoint: OPENCODE_ZEN_MODELS_ENDPOINT,
  anthropicBaseUrl: OPENCODE_ZEN_ANTHROPIC_BASE_URL,
  timeoutMs: OPENCODE_ZEN_MODELS_TIMEOUT_MS,
  ttlMs: OPENCODE_ZEN_MODELS_CACHE_TTL_MS,
  auditContext: "opencode-zen-model-discovery",
  starterModelAuditContext: "opencode-zen-onboarding-model-discovery",
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

export const {
  buildStaticProvider: buildStaticOpencodeZenProviderConfig,
  buildLiveProvider: buildOpencodeZenLiveProviderConfig,
  resolveStarterModel: resolveOpencodeZenStarterModel,
} = opencodeZenCatalog;

export function listOpencodeZenModelCatalogEntries(): ModelCatalogEntry[] {
  return listProviderCatalogSnapshotEntries(opencodeZenCatalog.getSnapshot());
}

export function resolveOpencodeZenModel(modelId: string): ProviderRuntimeModel | undefined {
  return opencodeZenCatalog.getSnapshot().get(modelId.trim().toLowerCase())?.model;
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
  if (
    normalized === OPENCODE_ZEN_ANTHROPIC_BASE_URL ||
    normalized === OPENCODE_ZEN_OPENAI_BASE_URL
  ) {
    return isAnthropicRoute ? OPENCODE_ZEN_ANTHROPIC_BASE_URL : OPENCODE_ZEN_OPENAI_BASE_URL;
  }
  return undefined;
}
