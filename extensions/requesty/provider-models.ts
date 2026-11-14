import { parseStrictFiniteNumber } from "openclaw/plugin-sdk/number-runtime";
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { asPositiveSafeInteger, isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import manifest from "./openclaw.plugin.json" with { type: "json" };

export const REQUESTY_PROVIDER_ID = "requesty";

const REQUESTY_MANIFEST_CATALOG = manifest.modelCatalog.providers.requesty;
const REQUESTY_STATIC_MODELS = buildManifestModelProviderConfig({
  providerId: REQUESTY_PROVIDER_ID,
  catalog: REQUESTY_MANIFEST_CATALOG,
}).models;
const REQUESTY_DEFAULT_MODEL = REQUESTY_STATIC_MODELS[0]!;

export const REQUESTY_BASE_URL = REQUESTY_MANIFEST_CATALOG.baseUrl;
// Managed policies are routed by bare name and filtered to the caller's key.
export const REQUESTY_MODELS_PATH = "models/managed";
export const REQUESTY_MODELS_URL = `${REQUESTY_BASE_URL}${REQUESTY_MODELS_PATH}`;
export const REQUESTY_DEFAULT_MODEL_ID = REQUESTY_DEFAULT_MODEL.id;
export const REQUESTY_DEFAULT_MODEL_REF = `${REQUESTY_PROVIDER_ID}/${REQUESTY_DEFAULT_MODEL_ID}`;
export const REQUESTY_DEFAULT_CONTEXT_WINDOW = REQUESTY_DEFAULT_MODEL.contextWindow;
export const REQUESTY_DEFAULT_MAX_TOKENS = REQUESTY_DEFAULT_MODEL.maxTokens;

// Operator rows may keep hosting prefixes (`vertex/claude-sonnet-4-6`), so
// prompt-cache TTL eligibility keys on the model segment alone.
export function isRequestyAnthropicModel(modelId: string): boolean {
  return /(?:^|\/)claude-/i.test(modelId);
}

export function getStaticRequestyModelCatalog(): ModelDefinitionConfig[] {
  return REQUESTY_STATIC_MODELS.map((model) => ({ ...model, input: [...model.input] }));
}

function toPricePerMillion(perToken: unknown): number {
  const price = (parseStrictFiniteNumber(perToken) ?? 0) * 1_000_000;
  return Number.isFinite(price) && price >= 0 ? price : 0;
}

/** Requesty publishes per-token USD prices; OpenClaw costs are per million tokens. */
function toModelDefinition(row: Record<string, unknown>, id: string): ModelDefinitionConfig {
  const fallback = REQUESTY_STATIC_MODELS.find((model) => model.id === id);
  const reasoning = row.supports_reasoning === true;
  return {
    id,
    name: id,
    reasoning,
    input: row.supports_vision === true ? ["text", "image"] : ["text"],
    // The router's base URL reads as a custom endpoint, which disables effort
    // selection by default; Requesty parses plain `reasoning_effort`.
    ...(reasoning ? { compat: { supportsReasoningEffort: true } } : {}),
    cost: {
      input: toPricePerMillion(row.input_price),
      output: toPricePerMillion(row.output_price),
      cacheRead: toPricePerMillion(row.cached_price),
      cacheWrite: toPricePerMillion(row.caching_price),
    },
    contextWindow:
      asPositiveSafeInteger(row.context_window) ??
      fallback?.contextWindow ??
      REQUESTY_DEFAULT_CONTEXT_WINDOW,
    maxTokens:
      asPositiveSafeInteger(row.max_output_tokens) ??
      fallback?.maxTokens ??
      REQUESTY_DEFAULT_MAX_TOKENS,
  };
}

export function projectRequestyModels(rows: readonly unknown[]): ModelDefinitionConfig[] {
  const models: ModelDefinitionConfig[] = [];
  const discoveredIds = new Set<string>();
  for (const row of rows) {
    // Malformed rows are skipped so one bad entry never hides the rest of the catalog.
    if (!isRecord(row) || typeof row.id !== "string") {
      continue;
    }
    const id = row.id.trim();
    // Model selection reads a trailing @suffix as an auth profile, so regional
    // policies (`claude-sonnet-4-6@eu`) would silently lose their routing.
    if (!id || id.includes("@") || discoveredIds.has(id) || row.api !== "chat") {
      continue;
    }
    models.push(toModelDefinition(row, id));
    discoveredIds.add(id);
  }
  return models;
}
