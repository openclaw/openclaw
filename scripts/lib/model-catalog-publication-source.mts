import { normalizeModelCatalog } from "@openclaw/model-catalog-core/model-catalog-normalize";
import { MODELS_DEV_CATALOG_URL } from "@openclaw/model-catalog-core/model-catalog-pricing";
import { normalizeModelCatalogProviderId } from "@openclaw/model-catalog-core/model-catalog-refs";
import { parseStrictFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ModelCatalogModel } from "../../packages/model-catalog-core/src/model-catalog-types.js";
import type { RemoteModelCatalogBundle as PublishedModelCatalogBundle } from "../../packages/model-catalog-core/src/remote-catalog-bundle.js";
const SCRIPT_LABEL = "publish-model-catalog";
const PRICING_FETCH_TIMEOUT_MS = 60_000;
const MAX_PRICING_CATALOG_BYTES = 5 * 1024 * 1024;
export type ModelCatalogManifestInput = {
  pluginId: string;
  manifestPath: string;
  manifest: {
    providers?: string[];
    modelCatalog?: {
      providers?: Record<string, unknown>;
      modelsDev?: Record<string, unknown>;
      suppressions?: Array<{ provider?: string; model?: string; when?: unknown }>;
    };
    modelPricing?: { providers?: Record<string, unknown> };
  };
};

type ModelsDevModel = Record<string, unknown> & {
  id: string;
  modalities: { input: unknown[]; output: unknown[] };
  limit: Record<string, unknown>;
};
type ModelCatalogHydrationCounts = { added: number; filled: number; skipped: number };
type ModelCatalogHydrationResult = Record<string, ModelCatalogHydrationCounts>;
export type ModelCatalogSourceLoader = (url: string, label: string) => Promise<unknown>;
async function readJsonResponse(response: Response, source: string) {
  if (!response.ok) {
    throw new Error(`${source} request failed: HTTP ${response.status}`);
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_PRICING_CATALOG_BYTES) {
    throw new Error(`${source} response exceeds ${MAX_PRICING_CATALOG_BYTES} bytes`);
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error(`${source} response has no body`);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > MAX_PRICING_CATALOG_BYTES) {
      await reader.cancel();
      throw new Error(`${source} response exceeds ${MAX_PRICING_CATALOG_BYTES} bytes`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error(`${source} response is malformed JSON`);
  }
  return payload;
}

export function createModelCatalogSourceLoader(
  fetchImpl: typeof fetch = fetch,
): ModelCatalogSourceLoader {
  // Metadata and pricing consume the same response within one publication. A failed
  // metadata request must not be retried as pricing and publish a smaller catalog.
  const sources = new Map<string, Promise<unknown>>();
  return (url, label) => {
    let source = sources.get(url);
    if (!source) {
      source = fetchImpl(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(PRICING_FETCH_TIMEOUT_MS),
      })
        .then((response) => readJsonResponse(response, label))
        .catch((cause: unknown) => {
          throw new Error(`${label} catalog unavailable: ${String(cause)}`, { cause });
        });
      sources.set(url, source);
    }
    return source;
  };
}

function isModelsDevModel(value: unknown, modelId: string): value is ModelsDevModel {
  return (
    isRecord(value) &&
    value.id === modelId &&
    isRecord(value.modalities) &&
    Array.isArray(value.modalities.input) &&
    Array.isArray(value.modalities.output) &&
    isRecord(value.limit)
  );
}

// Metadata only: cost stays with the provider pricing policy in enrichModelCatalogPricing.
function translateModelsDevModel(model: ModelsDevModel): ModelCatalogModel {
  const contextWindow = parseStrictFiniteNumber(model.limit.context);
  const maxTokens = parseStrictFiniteNumber(model.limit.output);
  return {
    id: model.id,
    ...(typeof model.name === "string" ? { name: model.name } : {}),
    ...(typeof model.reasoning === "boolean" ? { reasoning: model.reasoning } : {}),
    input: [
      ...new Set(
        model.modalities.input.flatMap((value) =>
          value === "text" || value === "image" ? value : value === "pdf" ? "document" : [],
        ),
      ),
    ],
    ...(contextWindow !== undefined && contextWindow > 0 ? { contextWindow } : {}),
    ...(maxTokens !== undefined && maxTokens > 0 ? { maxTokens } : {}),
  };
}

const HYDRATED_MODEL_FIELDS = [
  "name",
  "reasoning",
  "input",
  "contextWindow",
  "maxTokens",
] as const satisfies readonly (keyof ModelCatalogModel)[];

export async function hydrateModelCatalogFromModelsDev(options: {
  bundle: PublishedModelCatalogBundle;
  manifests: ModelCatalogManifestInput[];
  fetchImpl?: typeof fetch;
  loadSource?: ModelCatalogSourceLoader;
}): Promise<ModelCatalogHydrationResult> {
  const result: ModelCatalogHydrationResult = {};
  const mappings = new Map<string, string>();
  const suppressions = new Set<string>();
  for (const { manifest } of options.manifests) {
    const ownedProviders = new Set((manifest.providers ?? []).map(normalizeModelCatalogProviderId));
    const catalog = normalizeModelCatalog(manifest.modelCatalog, { ownedProviders });
    for (const [provider, source] of Object.entries(catalog?.modelsDev ?? {})) {
      if (catalog?.providers?.[provider] && options.bundle.providers[provider]) {
        mappings.set(provider, source);
      }
    }
    // Endpoint-specific rules remain runtime-owned. Another plugin cannot veto
    // an owner's imports through an unowned shared-catalog suppression.
    for (const { provider, model, when } of catalog?.suppressions ?? []) {
      if (ownedProviders.has(provider) && when === undefined) {
        suppressions.add(`${provider}/${model.toLowerCase()}`);
      }
    }
  }
  if (mappings.size === 0) {
    return result;
  }
  const loadSource = options.loadSource ?? createModelCatalogSourceLoader(options.fetchImpl);
  const catalog = await loadSource(MODELS_DEV_CATALOG_URL, "models.dev");
  if (!isRecord(catalog)) {
    throw new Error("models.dev response is not a JSON object");
  }
  for (const [providerId, provider] of Object.entries(options.bundle.providers)) {
    const upstreamProviderId = mappings.get(providerId);
    if (!upstreamProviderId) {
      continue;
    }
    const upstreamProvider = catalog[upstreamProviderId];
    if (
      !isRecord(upstreamProvider) ||
      upstreamProvider.id !== upstreamProviderId ||
      !isRecord(upstreamProvider.models)
    ) {
      // One renamed or broken upstream provider must not freeze every other
      // provider's catalog updates. Its manifest rows still publish as authored.
      process.stderr.write(
        `[${SCRIPT_LABEL}] warning: models.dev catalog missing or malformed for provider ${upstreamProviderId}; publishing ${providerId} without models.dev hydration\n`,
      );
      continue;
    }
    if (provider.models.some((model) => model.api !== undefined)) {
      process.stderr.write(
        `[${SCRIPT_LABEL}] warning: skipping models.dev hydration for ${providerId}; its rows pick a transport per model\n`,
      );
      continue;
    }
    const existing = new Map(provider.models.map((model) => [model.id, model]));
    let filled = 0;
    let skipped = 0;
    const additions = Object.entries(upstreamProvider.models).flatMap(([modelId, rawModel]) => {
      // Agents need tool calling; models.dev rows without it are embeddings, image, guard, and
      // safety models that would only clutter the picker.
      if (
        !isModelsDevModel(rawModel, modelId) ||
        rawModel.tool_call !== true ||
        !rawModel.modalities.output.includes("text") ||
        rawModel.status === "deprecated" ||
        rawModel.status === "retired" ||
        suppressions.has(`${providerId}/${modelId.toLowerCase()}`)
      ) {
        skipped += 1;
        return [];
      }
      const current = existing.get(modelId);
      if (!current) {
        return [translateModelsDevModel(rawModel)];
      }
      const translated = translateModelsDevModel(rawModel);
      let modelFilled = false;
      for (const key of HYDRATED_MODEL_FIELDS) {
        if (current[key] === undefined && translated[key] !== undefined) {
          Object.assign(current, { [key]: translated[key] });
          modelFilled = true;
        }
      }
      if (modelFilled) {
        filled += 1;
      }
      return [];
    });
    provider.models.push(...additions);
    result[providerId] = { added: additions.length, filled, skipped };
  }
  return result;
}
