import type { ModelCatalogEntry } from "openclaw/plugin-sdk/agent-runtime";
import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import {
  buildOpenAICompatibleLiveModels,
  createUpstreamProviderCatalog,
  listProviderCatalogSnapshotEntries,
  projectProviderCatalogSnapshotRows,
  type ProviderCatalogSnapshot,
  type ProjectedUpstreamProviderCatalogModel as OpencodeGoModelDefinition,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { normalizeBaseUrl } from "openclaw/plugin-sdk/provider-http";
import { normalizeModelCompat } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { isOpencodeGoKimiNoReasoningModelId } from "./provider-policy-api.js";

const PROVIDER_ID = "opencode-go";

const OPENCODE_GO_OPENAI_BASE_URL = "https://opencode.ai/zen/go/v1";
const OPENCODE_GO_ANTHROPIC_BASE_URL = "https://opencode.ai/zen/go";
const OPENCODE_GO_MODELS_ENDPOINT = "https://opencode.ai/zen/go/v1/models";
const OPENCODE_UPSTREAM_CATALOG_ENDPOINT = "https://models.opencode.ai/api.json";
const OPENCODE_GO_MODELS_TIMEOUT_MS = 5_000;
const OPENCODE_GO_MODELS_CACHE_TTL_MS = 60_000;
const OPENCODE_GO_MANIFEST_PROVIDER = manifest.modelCatalog.providers[PROVIDER_ID];
const OPENCODE_GO_SEED_CATALOG: ProviderCatalogSnapshot = new Map(
  OPENCODE_GO_MANIFEST_PROVIDER.models.map((row) => {
    const inheritedTransport = {
      ...row,
      provider: PROVIDER_ID,
      api: "api" in row ? row.api : OPENCODE_GO_MANIFEST_PROVIDER.api,
      baseUrl: "baseUrl" in row ? row.baseUrl : OPENCODE_GO_MANIFEST_PROVIDER.baseUrl,
    };
    // SAFETY: Bundled rows and inherited transport supply the complete runtime model shape.
    const hydrated = inheritedTransport as OpencodeGoModelDefinition;
    // SAFETY: Normalization preserves the hydrated model's transport and input shape.
    const model = normalizeModelCompat(hydrated) as OpencodeGoModelDefinition;
    return [
      model.id.toLowerCase(),
      {
        model,
        ...("status" in row && (row.status === "deprecated" || row.status === "preview")
          ? { status: row.status }
          : {}),
      },
    ];
  }),
);
const OPENCODE_GO_PROVIDER_ROUTE = {
  api: "openai-completions",
  baseUrl: OPENCODE_GO_OPENAI_BASE_URL,
} as const;

// The account listing owns which Go models exist. Upstream metadata enriches the
// ids it knows and its lifecycle hides deprecated ones; ids it does not know yet
// keep the listing's default OpenAI-compatible route.
function projectOpencodeGoListedRows(
  rows: readonly unknown[],
  snapshot: ProviderCatalogSnapshot,
): OpencodeGoModelDefinition[] {
  const unknown = buildOpenAICompatibleLiveModels(rows, {
    ...OPENCODE_GO_PROVIDER_ROUTE,
    models: [],
  })
    .filter((model) => !snapshot.has(model.id.toLowerCase()))
    .map((model) => {
      const listed = normalizeModelCompat({
        ...model,
        ...OPENCODE_GO_PROVIDER_ROUTE,
        provider: PROVIDER_ID,
        input: model.input.includes("image") ? ["text", "image"] : ["text"],
      });
      // SAFETY: Normalization keeps the assigned Go route and text/image input.
      return listed as OpencodeGoModelDefinition;
    });
  return [...projectProviderCatalogSnapshotRows(rows, snapshot), ...unknown];
}
const opencodeGoCatalog = createUpstreamProviderCatalog({
  providerId: PROVIDER_ID,
  seed: OPENCODE_GO_SEED_CATALOG,
  providerConfig: OPENCODE_GO_PROVIDER_ROUTE,
  projectRows: projectOpencodeGoListedRows,
  metadataEndpoint: OPENCODE_UPSTREAM_CATALOG_ENDPOINT,
  modelsEndpoint: OPENCODE_GO_MODELS_ENDPOINT,
  anthropicBaseUrl: OPENCODE_GO_ANTHROPIC_BASE_URL,
  timeoutMs: OPENCODE_GO_MODELS_TIMEOUT_MS,
  ttlMs: OPENCODE_GO_MODELS_CACHE_TTL_MS,
  auditContext: "opencode-go-model-discovery",
  starterModelAuditContext: "opencode-go-onboarding-model-discovery",
  isStaticEntryActive: (entry) => !entry?.status,
  decorateModel: (model) =>
    model.api === "anthropic-messages" && model.id.startsWith("qwen")
      ? { ...model, compat: { ...model.compat, thinkingFormat: "qwen" } }
      : model,
});

export const {
  buildStaticProvider: buildStaticOpencodeGoProviderConfig,
  buildLiveProvider: buildOpencodeGoLiveProviderConfig,
  resolveStarterModel: resolveOpencodeGoStarterModel,
} = opencodeGoCatalog;

export function listOpencodeGoModelCatalogEntries(): ModelCatalogEntry[] {
  return listProviderCatalogSnapshotEntries(opencodeGoCatalog.getSnapshot());
}

export function resolveOpencodeGoModel(modelId: string): ProviderRuntimeModel | undefined {
  // Public upstream metadata does not establish another account's Go entitlement.
  return OPENCODE_GO_SEED_CATALOG.get(modelId.trim().toLowerCase())?.model;
}

export function normalizeOpencodeGoResolvedModel(
  model: ProviderRuntimeModel,
): ProviderRuntimeModel | undefined {
  if (!isOpencodeGoKimiNoReasoningModelId(model.id)) {
    return undefined;
  }
  const compat =
    model.compat && typeof model.compat === "object" && !Array.isArray(model.compat)
      ? model.compat
      : undefined;
  if (!model.reasoning && !compat?.supportsReasoningEffort) {
    return undefined;
  }
  return {
    ...model,
    reasoning: false,
    compat: {
      ...compat,
      supportsReasoningEffort: false,
    },
  };
}

export function normalizeOpencodeGoBaseUrl(params: {
  api?: string | null;
  baseUrl?: string;
}): string | undefined {
  const normalized = normalizeBaseUrl(params.baseUrl);
  if (!normalized) {
    return undefined;
  }
  if (normalized === OPENCODE_GO_OPENAI_BASE_URL) {
    return OPENCODE_GO_OPENAI_BASE_URL;
  }
  if (normalized === OPENCODE_GO_ANTHROPIC_BASE_URL) {
    return OPENCODE_GO_ANTHROPIC_BASE_URL;
  }
  if (normalized === "https://opencode.ai/go") {
    return OPENCODE_GO_ANTHROPIC_BASE_URL;
  }
  if (normalized === "https://opencode.ai/go/v1") {
    return params.api === "anthropic-messages"
      ? OPENCODE_GO_ANTHROPIC_BASE_URL
      : OPENCODE_GO_OPENAI_BASE_URL;
  }
  return undefined;
}
