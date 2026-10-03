import { normalizeOpenRouterModelPricing } from "openclaw/plugin-sdk/model-catalog-pricing";
import type { OpenAICompatibleModelDiscoveryOptions } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  asOptionalRecord,
  asPositiveSafeInteger,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import manifest from "./openclaw.plugin.json" with { type: "json" };

export const FLEXAI_BASE_URL = manifest.modelCatalog.providers.flexai.baseUrl;
export const FLEXAI_MODEL_CATALOG = manifest.modelCatalog.providers.flexai.models;

/** FlexAI advertises per-row capabilities as a `supports` string array. */
const CHAT_CAPABILITY = "chat";
const TOOL_CAPABILITY = "tool_use";
const REASONING_EFFORT_CAPABILITY = "reasoning_effort";
const REASONING_CATEGORY = "reasoning";
const IMAGE_INPUT_MODALITY = "image";

// FlexAI validates `reasoning_effort` per route rather than uniformly. Measured
// 2026-10-02: the gpt-oss routes reject everything outside low/medium/high;
// DeepSeek-V4-Flash-0731 and GLM-5.3-Flash also accept minimal and max while
// rejecting unknown spellings; the remaining routes accept any value without
// validating it. Seeded rows carry the list measured on their own route, and a
// discovered row declares only the levels every validating route accepts.
const DISCOVERED_REASONING_EFFORTS = ["low", "medium", "high"];

function readStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export function buildFlexAICatalogModels(): ModelDefinitionConfig[] {
  return buildFlexAIProvider().models;
}

function projectFlexAIModels(
  rows: readonly unknown[],
  fallback: ModelProviderConfig,
): ModelDefinitionConfig[] {
  const seeds = new Map(fallback.models.map((model) => [model.id, model]));
  const models = new Map<string, ModelDefinitionConfig>();
  for (const row of rows) {
    const record = asOptionalRecord(row);
    const id = normalizeOptionalString(record?.id);
    const supports = readStringList(record?.supports);
    const contextWindow = asPositiveSafeInteger(record?.context_length);
    if (
      !record ||
      !id ||
      id.length > 512 ||
      /[\s\p{Cc}]/u.test(id) ||
      (record.object !== undefined && record.object !== "model") ||
      // Text inference only. Embedding, speech, transcription, OCR and
      // image-generation rows share this endpoint and are not selectable as
      // chat models. `chat` is the only `supports` entry used as a filter:
      // the array is incomplete for other capabilities, so a row that streams
      // can still omit `streaming`.
      !supports.includes(CHAT_CAPABILITY) ||
      !contextWindow
    ) {
      continue;
    }
    // `is_ready` is deliberately not a filter: FlexAI reports it false for rows
    // that serve requests normally, so it is not a reliable availability
    // signal. Every row it flagged on 2026-10-02 was non-chat and is already
    // excluded by the capability check above.
    const seed = seeds.get(id);
    const reasoning =
      seed?.reasoning ??
      (supports.includes(REASONING_EFFORT_CAPABILITY) ||
        normalizeOptionalString(record.category) === REASONING_CATEGORY);
    const seededEfforts = seed?.compat?.supportedReasoningEfforts;
    models.set(id, {
      ...seed,
      id,
      name: normalizeOptionalString(record.name) ?? seed?.name ?? id,
      reasoning,
      input: readStringList(record.input_modalities).includes(IMAGE_INPUT_MODALITY)
        ? ["text", "image"]
        : ["text"],
      contextWindow,
      // FlexAI's `max_output_length` mirrors `context_length` on every row, so
      // it is not an independent output budget — prompt and completion draw on
      // one shared window. Publishing the context window keeps the shared
      // transport's clamp a no-op instead of inventing a ceiling the API does
      // not impose.
      maxTokens: contextWindow,
      cost: normalizeOpenRouterModelPricing(record.pricing) ?? {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      compat: {
        ...seed?.compat,
        supportsTools: supports.includes(TOOL_CAPABILITY),
        ...(reasoning && !seededEfforts
          ? { supportedReasoningEfforts: DISCOVERED_REASONING_EFFORTS }
          : {}),
      },
    });
  }
  return [...models.values()].toSorted((left, right) => left.id.localeCompare(right.id));
}

export const FLEXAI_MODEL_DISCOVERY: OpenAICompatibleModelDiscoveryOptions = {
  projectRows: projectFlexAIModels,
};

export function buildFlexAIProvider(): ModelProviderConfig {
  return buildManifestModelProviderConfig({
    providerId: "flexai",
    catalog: manifest.modelCatalog.providers.flexai,
  });
}
