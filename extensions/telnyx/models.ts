/**
 * Telnyx model catalog, compat metadata, and live row projection.
 */
import {
  buildManifestModelDefinition,
  readManifestProviderDefaultModelRef,
} from "openclaw/plugin-sdk/provider-catalog-shared";
import type {
  ModelCompatConfig,
  ModelDefinitionConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const TELNYX_MANIFEST_CATALOG = manifest.modelCatalog.providers.telnyx;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;

// Telnyx streams usage chunks and expects the vLLM-style `max_tokens` field;
// verified live against /v2/ai/openai/chat/completions (2026-07-28).
const TELNYX_MODEL_COMPAT: ModelCompatConfig = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsUsageInStreaming: true,
  supportsTools: true,
  maxTokensField: "max_tokens",
};

/** Base URL for Telnyx's OpenAI-compatible inference API. */
export const TELNYX_BASE_URL = TELNYX_MANIFEST_CATALOG.baseUrl;
/** Default Telnyx model id used for onboarding. */
export const TELNYX_DEFAULT_MODEL_ID = TELNYX_MANIFEST_CATALOG.defaultModel;
/** Default Telnyx model ref used for onboarding. */
export const TELNYX_DEFAULT_MODEL_REF = readManifestProviderDefaultModelRef(manifest, "telnyx")!;
/** Bundled fallback rows for Telnyx-hosted models available at release time. */
export const TELNYX_MODEL_CATALOG = TELNYX_MANIFEST_CATALOG.models;

/** Builds the network-free fallback catalog. */
export function buildStaticTelnyxModels(): ModelDefinitionConfig[] {
  return TELNYX_MODEL_CATALOG.map(
    buildManifestModelDefinition({
      providerId: "telnyx",
      catalog: TELNYX_MANIFEST_CATALOG,
      decorate: (normalized) => ({
        ...normalized,
        // Manifest rows carry per-model compat (e.g. codeMode tiers for shared
        // upstream models); keep it layered over the provider-wide transport policy.
        compat: { ...TELNYX_MODEL_COMPAT, ...normalized.compat },
      }),
    }),
  );
}

type TelnyxLiveModelRow = {
  id?: unknown;
  object?: unknown;
  task?: unknown;
  context_length?: unknown;
  max_completion_tokens?: unknown;
  is_vision_supported?: unknown;
  pricing?: unknown;
};

function readPositiveInteger(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

/**
 * Telnyx publishes prices as decimal strings already denominated per 1M
 * tokens (`pricing.unit === "1M_tokens"`); reject other units so a future
 * unit change falls back to bundled costs instead of misbilling.
 */
function readTelnyxPricing(value: unknown): {
  input?: number;
  output?: number;
  cacheRead?: number;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const pricing = value as Record<string, unknown>;
  if (pricing.unit !== undefined && pricing.unit !== "1M_tokens") {
    return {};
  }
  const readPrice = (raw: unknown): number | undefined => {
    if (typeof raw !== "number" && (typeof raw !== "string" || !raw.trim())) {
      return undefined;
    }
    const number = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(number) && number >= 0 ? number : undefined;
  };
  return {
    input: readPrice(pricing.input),
    output: readPrice(pricing.output),
    cacheRead: readPrice(pricing.cached_prompt),
  };
}

function projectLiveModel(
  row: TelnyxLiveModelRow,
  fallback: ModelDefinitionConfig | undefined,
): ModelDefinitionConfig | undefined {
  if (row.object !== undefined && row.object !== "model") {
    return undefined;
  }
  // Telnyx labels chat models "text-generation" (hosted) or "text generation"
  // (proxied); other tasks (embeddings, TTS) must not surface as chat models.
  const task = typeof row.task === "string" ? row.task.trim().toLowerCase() : "";
  if (task.replace(/\s+/g, "-") !== "text-generation") {
    return undefined;
  }
  const id = typeof row.id === "string" ? row.id.trim() : "";
  if (!id) {
    return undefined;
  }

  const pricing = readTelnyxPricing(row.pricing);
  return {
    id,
    name: fallback?.name ?? id,
    reasoning: fallback?.reasoning ?? false,
    input: row.is_vision_supported === true ? ["text", "image"] : (fallback?.input ?? ["text"]),
    cost: {
      input: pricing.input ?? fallback?.cost.input ?? 0,
      output: pricing.output ?? fallback?.cost.output ?? 0,
      cacheRead: pricing.cacheRead ?? fallback?.cost.cacheRead ?? 0,
      cacheWrite: fallback?.cost.cacheWrite ?? 0,
    },
    contextWindow:
      readPositiveInteger(row.context_length) ?? fallback?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens:
      readPositiveInteger(row.max_completion_tokens) ?? fallback?.maxTokens ?? DEFAULT_MAX_TOKENS,
    compat: fallback?.compat ?? { ...TELNYX_MODEL_COMPAT },
  };
}

/** Projects Telnyx's authenticated `/models` response into OpenClaw model rows. */
export function projectTelnyxLiveModels(rows: readonly unknown[]): ModelDefinitionConfig[] {
  const fallbacks = new Map(buildStaticTelnyxModels().map((model) => [model.id, model]));
  const seen = new Set<string>();
  const models: ModelDefinitionConfig[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      continue;
    }
    const model = projectLiveModel(
      row as TelnyxLiveModelRow,
      fallbacks.get(String((row as TelnyxLiveModelRow).id)),
    );
    if (!model || seen.has(model.id)) {
      continue;
    }
    seen.add(model.id);
    models.push(model);
  }
  return models;
}

/** Resolves a forward-compatible Telnyx model id not yet in the bundled catalog. */
export function resolveTelnyxDynamicModel(modelId: string) {
  const id = modelId.trim();
  if (!id || TELNYX_MODEL_CATALOG.some((model) => model.id === id)) {
    return undefined;
  }
  return {
    id,
    name: id,
    provider: "telnyx",
    api: "openai-completions" as const,
    baseUrl: TELNYX_BASE_URL,
    reasoning: false,
    input: ["text"] as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    compat: { ...TELNYX_MODEL_COMPAT },
  };
}
