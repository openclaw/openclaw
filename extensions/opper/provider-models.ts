import { normalizeOpenRouterModelPricing } from "openclaw/plugin-sdk/model-catalog-pricing";
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  asOptionalRecord,
  asPositiveSafeInteger,
  filterStringEntries,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import manifest from "./openclaw.plugin.json" with { type: "json" };

export const OPPER_PROVIDER_ID = "opper";

const OPPER_MANIFEST_CATALOG = manifest.modelCatalog.providers.opper;
const OPPER_STATIC_MODELS = buildManifestModelProviderConfig({
  providerId: OPPER_PROVIDER_ID,
  catalog: OPPER_MANIFEST_CATALOG,
}).models;
const OPPER_DEFAULT_MODEL = OPPER_STATIC_MODELS[0]!;
const OPPER_ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export const OPPER_BASE_URL = OPPER_MANIFEST_CATALOG.baseUrl;
// `view=simplified` lists each model once, by its bare pool name when several
// providers serve it, so the picker shows models rather than every route.
export const OPPER_MODELS_PATH = "models?view=simplified";
export const OPPER_MODELS_URL = `${OPPER_BASE_URL}${OPPER_MODELS_PATH}`;
export const OPPER_DEFAULT_MODEL_ID = OPPER_DEFAULT_MODEL.id;
export const OPPER_DEFAULT_MODEL_REF = `${OPPER_PROVIDER_ID}/${OPPER_DEFAULT_MODEL_ID}`;
export const OPPER_DEFAULT_CONTEXT_WINDOW = OPPER_DEFAULT_MODEL.contextWindow;
export const OPPER_DEFAULT_MAX_TOKENS = OPPER_DEFAULT_MODEL.maxTokens;

export function getStaticOpperModelCatalog(): ModelDefinitionConfig[] {
  return OPPER_STATIC_MODELS.map((model) => ({ ...model, input: [...model.input] }));
}

/**
 * Opper documents a row without a pricing object as a free-priced model. A pricing
 * object that does not parse is not free, so that row is left out rather than
 * accounted at zero.
 */
function readOpperCost(pricing: unknown): ModelDefinitionConfig["cost"] | undefined {
  return pricing === undefined ? { ...OPPER_ZERO_COST } : normalizeOpenRouterModelPricing(pricing);
}

/** Opper's `/models` rows use OpenRouter's shape plus an `opper` metadata block. */
function toModelDefinition(
  row: Record<string, unknown>,
  id: string,
  cost: ModelDefinitionConfig["cost"],
): ModelDefinitionConfig {
  const fallback = OPPER_STATIC_MODELS.find((model) => model.id === id);
  const opper = asOptionalRecord(row.opper);
  const architecture = asOptionalRecord(row.architecture);
  const reasoning = filterStringEntries(opper?.capabilities).includes("reasoning");
  return {
    id,
    name: id,
    reasoning,
    input: filterStringEntries(architecture?.input_modalities).includes("image")
      ? ["text", "image"]
      : ["text"],
    // The gateway's base URL reads as a custom endpoint, which disables effort
    // selection and streamed usage by default; Opper parses plain
    // `reasoning_effort` and sends a final usage chunk for `include_usage`.
    compat: {
      ...(reasoning ? { supportsReasoningEffort: true } : {}),
      supportsUsageInStreaming: true,
    },
    cost,
    contextWindow:
      asPositiveSafeInteger(row.context_length) ??
      fallback?.contextWindow ??
      OPPER_DEFAULT_CONTEXT_WINDOW,
    maxTokens:
      asPositiveSafeInteger(opper?.max_output_tokens) ??
      fallback?.maxTokens ??
      OPPER_DEFAULT_MAX_TOKENS,
  };
}

export function projectOpperModels(rows: readonly unknown[]): ModelDefinitionConfig[] {
  const models: ModelDefinitionConfig[] = [];
  const discoveredIds = new Set<string>();
  for (const row of rows) {
    const record = asOptionalRecord(row);
    const id = normalizeOptionalString(record?.id);
    // Malformed rows are skipped so one bad entry never hides the rest of the catalog.
    if (!record || !id || discoveredIds.has(id)) {
      continue;
    }
    // The catalog also lists embedding, image and speech models; only chat models fit here.
    const kind = normalizeOptionalString(asOptionalRecord(record.opper)?.type);
    const outputs = filterStringEntries(asOptionalRecord(record.architecture)?.output_modalities);
    if ((kind && kind !== "llm") || (outputs.length > 0 && !outputs.includes("text"))) {
      continue;
    }
    const cost = readOpperCost(record.pricing);
    if (!cost) {
      continue;
    }
    models.push(toModelDefinition(record, id, cost));
    discoveredIds.add(id);
  }
  return models;
}
