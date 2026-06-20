// Requesty provider module implements model/runtime integration.
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";

/** Supported input modality for a Requesty-routed model. */
export type RequestyModelInput = "text" | "image";

export const REQUESTY_BASE_URL = "https://router.requesty.ai/v1";
export const REQUESTY_MODELS_URL = "https://router.requesty.ai/v1/models";
export const REQUESTY_DEFAULT_MODEL_ID = "openai/gpt-4o";

export const REQUESTY_FALLBACK_CONTEXT_WINDOW = 128_000;
export const REQUESTY_FALLBACK_MAX_OUTPUT = 8_192;
export const REQUESTY_FALLBACK_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const;

function normalizeBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl ?? "").trim().replace(/\/+$/, "");
}

// Requesty documents both `/v1` and the bare host as a base. Canonicalize either
// onto the `/v1` OpenAI-compatible base so transport, config, and runtime
// metadata stay aligned.
export function normalizeRequestyBaseUrl(baseUrl: string | undefined): string | undefined {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) {
    return undefined;
  }
  if (normalized === REQUESTY_BASE_URL || normalized === "https://router.requesty.ai") {
    return REQUESTY_BASE_URL;
  }
  return undefined;
}

/** Per-model capability fields projected from the Requesty `/v1/models` payload. */
export type RequestyModelCapabilities = {
  name?: string;
  reasoning: boolean;
  input: RequestyModelInput[];
  supportsTools?: boolean;
  contextWindow?: number;
  maxTokens?: number;
};

function readBoolean(value: unknown): boolean {
  return value === true;
}

function readPositiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

// Requesty's `/v1/models` rows expose capability booleans (supports_reasoning,
// supports_vision, supports_tool_calling) and window sizes (context_window,
// max_output_tokens). Map the real fields rather than assuming a fixed shape so
// reasoning-capable upstream models (o-series, Claude extended thinking, etc.)
// are not silently downgraded to non-reasoning.
export function projectRequestyModelCapabilities(
  row: unknown,
): RequestyModelCapabilities | undefined {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return undefined;
  }
  const record = row as Record<string, unknown>;
  const input: RequestyModelInput[] = ["text"];
  if (readBoolean(record.supports_vision)) {
    input.push("image");
  }
  return {
    name: readString(record.id),
    reasoning: readBoolean(record.supports_reasoning),
    input,
    supportsTools: readBoolean(record.supports_tool_calling),
    contextWindow: readPositiveInt(record.context_window),
    maxTokens: readPositiveInt(record.max_output_tokens),
  };
}

export function buildRequestyProvider(): ModelProviderConfig {
  return {
    baseUrl: REQUESTY_BASE_URL,
    api: "openai-completions",
    models: [
      {
        id: REQUESTY_DEFAULT_MODEL_ID,
        name: "OpenAI: GPT-4o",
        reasoning: false,
        input: ["text", "image"],
        cost: REQUESTY_FALLBACK_COST,
        contextWindow: 128_000,
        maxTokens: 16_384,
      },
      {
        id: "anthropic/claude-sonnet-4-5",
        name: "Anthropic: Claude Sonnet 4.5",
        reasoning: true,
        input: ["text", "image"],
        cost: REQUESTY_FALLBACK_COST,
        contextWindow: 1_000_000,
        maxTokens: 64_000,
      },
      {
        id: "google/gemini-2.5-flash",
        name: "Google: Gemini 2.5 Flash",
        reasoning: true,
        input: ["text", "image"],
        cost: REQUESTY_FALLBACK_COST,
        contextWindow: 1_048_576,
        maxTokens: 65_536,
      },
    ],
  };
}
