import { buildLiveModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  asOptionalRecord,
  asPositiveSafeInteger,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  GOOGLE_GEMINI_MANIFEST_PROVIDER,
  GOOGLE_GEMINI_TEXT_MODEL_BY_ID,
  GOOGLE_GEMINI_TEXT_MODEL_IDS,
  GOOGLE_GEMINI_COST,
  buildGoogleStaticCatalogProvider,
} from "./provider-catalog.js";
import {
  isGoogleGeminiTextModelId,
  isGoogleTextGenerationModelId,
  resolveGoogleStaticModelId,
} from "./provider-models.js";

const GOOGLE_GEMINI_MODELS_CACHE_TTL_MS = 60_000;
const GOOGLE_GEMINI_MODELS_ENDPOINT = `${GOOGLE_GEMINI_MANIFEST_PROVIDER.baseUrl}/models?pageSize=1000`;

function googleLiveModelInput(id: string): ModelDefinitionConfig["input"] {
  if (!id.startsWith("gemma-")) {
    return ["text", "image", "video"];
  }
  const isMultimodalGemma =
    /^gemma-3-(?:4b|12b|27b)(?:-|$)/.test(id) ||
    id.startsWith("gemma-3n-") ||
    id.startsWith("gemma-4-");
  return isMultimodalGemma ? ["text", "image"] : ["text"];
}

function buildGoogleLiveModel(row: unknown): ModelDefinitionConfig | undefined {
  const record = asOptionalRecord(row);
  if (!record) {
    throw new Error("Google models.list returned an invalid model row");
  }
  const resourceName = normalizeOptionalString(record.name);
  const id = resourceName?.startsWith("models/") ? resourceName.slice("models/".length) : undefined;
  const methods = record.supportedGenerationMethods;
  const contextWindow = asPositiveSafeInteger(record.inputTokenLimit);
  const maxTokens = asPositiveSafeInteger(record.outputTokenLimit);
  // Gemini rows may advertise only the Interactions API; the effective endpoint
  // picks the transport when the model resolves (resolveGoogleModelApi).
  if (
    !id ||
    !isGoogleTextGenerationModelId(id) ||
    (!isGoogleGeminiTextModelId(id) &&
      (!Array.isArray(methods) || !methods.includes("generateContent"))) ||
    !contextWindow ||
    !maxTokens
  ) {
    return undefined;
  }
  // Compat flags apply to evaluated weights only. Resolve discovered id
  // variants (aliases, dated previews, -latest) to the bundled entry with the
  // same weights; ids that do not resolve keep no compat (fail closed).
  const staticId = resolveGoogleStaticModelId(id, GOOGLE_GEMINI_TEXT_MODEL_IDS);
  const staticModel = staticId ? GOOGLE_GEMINI_TEXT_MODEL_BY_ID.get(staticId) : undefined;
  return {
    id,
    name: normalizeOptionalString(record.displayName) ?? id,
    reasoning: record.thinking === true,
    // models.list omits modalities. Gemma has both text-only small variants and
    // multimodal families, so keep this capability distinction explicit.
    input: googleLiveModelInput(id),
    cost: GOOGLE_GEMINI_COST,
    contextWindow,
    maxTokens,
    ...(staticModel?.compat ? { compat: staticModel.compat } : {}),
    ...(staticModel?.thinkingLevelMap ? { thinkingLevelMap: staticModel.thinkingLevelMap } : {}),
  };
}

type GoogleLiveCatalogParams = {
  discoveryMode?: "strict";
  apiKey?: string;
  discoveryApiKey?: string;
};

export async function buildGoogleLiveCatalogProvider(
  params: GoogleLiveCatalogParams,
): Promise<ModelProviderConfig> {
  return (await loadGoogleLiveCatalog(params)).provider;
}

/** The provider config plus every model id the account listing returned, including hidden rows. */
export async function loadGoogleLiveCatalog(params: GoogleLiveCatalogParams): Promise<{
  provider: ModelProviderConfig;
  listedModelIds?: string[];
}> {
  const { models, ...providerConfig } = buildGoogleStaticCatalogProvider();
  let listedModelIds: string[] | undefined;
  const provider = await buildLiveModelProviderConfig({
    providerId: "google",
    endpoint: GOOGLE_GEMINI_MODELS_ENDPOINT,
    providerConfig,
    models,
    ...params,
    ttlMs: GOOGLE_GEMINI_MODELS_CACHE_TTL_MS,
    auditContext: "google-model-discovery",
    readRows(body: unknown): readonly unknown[] {
      const record = asOptionalRecord(body);
      if (!record || (record.models !== undefined && !Array.isArray(record.models))) {
        throw new Error("Google models.list returned an invalid model list");
      }
      return record.models ?? [];
    },
    buildRequestHeaders: ({ discoveryApiKey, apiKey }) => ({
      Accept: "application/json",
      ...((discoveryApiKey ?? apiKey) ? { "x-goog-api-key": discoveryApiKey ?? apiKey } : {}),
    }),
    projectRows(rows: readonly unknown[]): ModelDefinitionConfig[] {
      listedModelIds = rows.flatMap((row) => {
        const name = normalizeOptionalString(asOptionalRecord(row)?.name);
        return name?.startsWith("models/") ? [name.slice("models/".length)] : [];
      });
      const liveModels = rows
        .map(buildGoogleLiveModel)
        .filter((model): model is ModelDefinitionConfig => Boolean(model));
      return [...new Map(liveModels.map((model) => [model.id, model])).values()].toSorted((a, b) =>
        a.id.localeCompare(b.id),
      );
    },
  });
  return { provider, ...(listedModelIds ? { listedModelIds } : {}) };
}
