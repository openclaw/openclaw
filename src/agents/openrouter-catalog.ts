import type { Model } from "@mariozechner/pi-ai";
import type { ModelDefinitionConfig } from "../config/types.models.js";

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

export type OpenRouterModelPricing = {
  prompt: number;
  completion: number;
  request: number;
  image: number;
  webSearch: number;
  internalReasoning: number;
};

export type OpenRouterModelMeta = {
  id: string;
  name: string;
  contextLength: number | null;
  maxCompletionTokens: number | null;
  supportedParameters: string[];
  supportedParametersCount: number;
  supportsToolsMeta: boolean;
  modality: string | null;
  inferredParamB: number | null;
  createdAtMs: number | null;
  pricing: OpenRouterModelPricing | null;
};

export function normalizeCreatedAtMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  if (value <= 0) {
    return null;
  }
  if (value > 1e12) {
    return Math.round(value);
  }
  return Math.round(value * 1000);
}

export function inferParamBFromIdOrName(text: string): number | null {
  const raw = text.toLowerCase();
  const matches = raw.matchAll(/(?:^|[^a-z0-9])[a-z]?(\d+(?:\.\d+)?)b(?:[^a-z0-9]|$)/g);
  let best: number | null = null;
  for (const match of matches) {
    const numRaw = match[1];
    if (!numRaw) {
      continue;
    }
    const value = Number(numRaw);
    if (!Number.isFinite(value) || value <= 0) {
      continue;
    }
    if (best === null || value > best) {
      best = value;
    }
  }
  return best;
}

export function parseModality(modality: string | null): Array<"text" | "image"> {
  if (!modality) {
    return ["text"];
  }
  const normalized = modality.toLowerCase();
  const parts = normalized.split(/[^a-z]+/).filter(Boolean);
  const hasImage = parts.includes("image");
  return hasImage ? ["text", "image"] : ["text"];
}

function parseNumberString(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const num = Number(trimmed);
  if (!Number.isFinite(num)) {
    return null;
  }
  return num;
}

export function parseOpenRouterPricing(value: unknown): OpenRouterModelPricing | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const obj = value as Record<string, unknown>;
  const prompt = parseNumberString(obj.prompt);
  const completion = parseNumberString(obj.completion);
  const request = parseNumberString(obj.request) ?? 0;
  const image = parseNumberString(obj.image) ?? 0;
  const webSearch = parseNumberString(obj.web_search) ?? 0;
  const internalReasoning = parseNumberString(obj.internal_reasoning) ?? 0;

  if (prompt === null || completion === null) {
    return null;
  }
  return {
    prompt,
    completion,
    request,
    image,
    webSearch,
    internalReasoning,
  };
}

export function isFreeOpenRouterModel(entry: OpenRouterModelMeta): boolean {
  if (entry.id.endsWith(":free")) {
    return true;
  }
  if (!entry.pricing) {
    return false;
  }
  return entry.pricing.prompt === 0 && entry.pricing.completion === 0;
}

export async function fetchOpenRouterModels(
  fetchImpl: typeof fetch,
): Promise<OpenRouterModelMeta[]> {
  const res = await fetchImpl(OPENROUTER_MODELS_URL, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`OpenRouter /models failed: HTTP ${res.status}`);
  }
  const payload = (await res.json()) as { data?: unknown };
  const entries = Array.isArray(payload.data) ? payload.data : [];

  return entries
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const obj = entry as Record<string, unknown>;
      const id = typeof obj.id === "string" ? obj.id.trim() : "";
      if (!id) {
        return null;
      }
      const name = typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : id;

      const contextLength =
        typeof obj.context_length === "number" && Number.isFinite(obj.context_length)
          ? obj.context_length
          : null;

      const maxCompletionTokens =
        typeof obj.max_completion_tokens === "number" && Number.isFinite(obj.max_completion_tokens)
          ? obj.max_completion_tokens
          : typeof obj.max_output_tokens === "number" && Number.isFinite(obj.max_output_tokens)
            ? obj.max_output_tokens
            : null;

      const supportedParameters = Array.isArray(obj.supported_parameters)
        ? obj.supported_parameters
            .filter((value): value is string => typeof value === "string")
            .map((value) => value.trim())
            .filter(Boolean)
        : [];

      const supportedParametersCount = supportedParameters.length;
      const supportsToolsMeta = supportedParameters.includes("tools");

      const modality =
        typeof obj.modality === "string" && obj.modality.trim() ? obj.modality.trim() : null;

      const inferredParamB = inferParamBFromIdOrName(`${id} ${name}`);
      const createdAtMs = normalizeCreatedAtMs(obj.created_at);
      const pricing = parseOpenRouterPricing(obj.pricing);

      return {
        id,
        name,
        contextLength,
        maxCompletionTokens,
        supportedParameters,
        supportedParametersCount,
        supportsToolsMeta,
        modality,
        inferredParamB,
        createdAtMs,
        pricing,
      } satisfies OpenRouterModelMeta;
    })
    .filter((entry): entry is OpenRouterModelMeta => Boolean(entry));
}

function resolvePositiveNumber(value: number | null | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }
  return Math.round(fallback);
}

const REASONING_HINTS = ["reasoning", "reasoning_effort"];

export function buildOpenRouterModelDefinition(params: {
  entry: OpenRouterModelMeta;
  baseModel: Model<"openai-completions">;
}): ModelDefinitionConfig {
  const { entry, baseModel } = params;
  const reasoning = entry.supportedParameters.some((param) =>
    REASONING_HINTS.some((hint) => param.toLowerCase().includes(hint)),
  );
  const pricing = entry.pricing;
  return {
    id: entry.id,
    name: entry.name || entry.id,
    reasoning,
    input: parseModality(entry.modality),
    cost: {
      input: pricing?.prompt ?? 0,
      output: pricing?.completion ?? 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: resolvePositiveNumber(entry.contextLength, baseModel.contextWindow),
    maxTokens: resolvePositiveNumber(entry.maxCompletionTokens, baseModel.maxTokens),
  } satisfies ModelDefinitionConfig;
}
