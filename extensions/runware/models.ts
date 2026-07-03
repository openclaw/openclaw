// Runware plugin module implements model row parsing behavior.
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  asPositiveSafeInteger,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

export const RUNWARE_BASE_URL = "https://api.runware.ai/v1";
export const RUNWARE_DEFAULT_MODEL_ID = "deepseek-v4-flash";
export const RUNWARE_DEFAULT_MODEL_REF = `runware/${RUNWARE_DEFAULT_MODEL_ID}`;

// GET /v1/models requires auth (unauthenticated -> 401), so this single
// illustrative entry is all buildStaticRunwareProvider can offer offline.
export const RUNWARE_FALLBACK_MODELS: ModelDefinitionConfig[] = [
  {
    id: RUNWARE_DEFAULT_MODEL_ID,
    name: "DeepSeek V4 Flash (illustrative)",
    api: "openai-completions",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 65_536,
  },
];

type RunwareModelRow = {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  max_output_tokens?: unknown;
  input_modalities?: unknown;
  reasoning?: unknown;
  supports_reasoning?: unknown;
  pricing?: {
    prompt?: unknown;
    completion?: unknown;
    input_cache_read?: unknown;
    input_cache_write?: unknown;
  };
};

// OpenClaw's persisted catalog schema (ModelCatalogInput) only accepts
// "text" | "image" | "document", not "video"/"audio" — writing those values
// gets the whole catalog rejected. No bundled provider uses beyond text/image.
function mapRunwareInputModalities(raw: unknown): Array<"text" | "image"> {
  const advertised = Array.isArray(raw) ? raw : [];
  return advertised.includes("image") ? ["text", "image"] : ["text"];
}

function humanizeRunwareModelId(id: string): string {
  return id.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function parseRunwarePriceToPerMillion(value: unknown): number {
  const parsed = typeof value === "string" ? Number.parseFloat(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed * 1_000_000 : 0;
}

// Runware's /v1/models rows carry no reasoning-capability field; default false
// (a false negative is safer than misreporting a model as reasoning-capable).
export function parseRunwareModelRow(raw: unknown): ModelDefinitionConfig | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const row = raw as RunwareModelRow;
  const id = normalizeOptionalString(row.id);
  if (!id) {
    return null;
  }
  const reasoning = row.reasoning === true || row.supports_reasoning === true;
  return {
    id,
    name: normalizeOptionalString(row.name) ?? humanizeRunwareModelId(id),
    api: "openai-completions",
    reasoning,
    input: mapRunwareInputModalities(row.input_modalities),
    cost: {
      input: parseRunwarePriceToPerMillion(row.pricing?.prompt),
      output: parseRunwarePriceToPerMillion(row.pricing?.completion),
      cacheRead: parseRunwarePriceToPerMillion(row.pricing?.input_cache_read),
      cacheWrite: parseRunwarePriceToPerMillion(row.pricing?.input_cache_write),
    },
    contextWindow: asPositiveSafeInteger(row.context_length) ?? 128_000,
    maxTokens: asPositiveSafeInteger(row.max_output_tokens) ?? 4_096,
  };
}
