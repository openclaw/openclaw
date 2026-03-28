import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-models";

export const FPT_AI_FACTORY_BASE_URL = "https://mkp-api.fptcloud.com/v1";
export const FPT_AI_FACTORY_DEFAULT_MODEL_ID = "Qwen3-32B";
export const FPT_AI_FACTORY_DEFAULT_MODEL_REF = `fpt-ai-factory/${FPT_AI_FACTORY_DEFAULT_MODEL_ID}`;

const FPT_AI_FACTORY_DEFAULT_CONTEXT_WINDOW = 128000;
const FPT_AI_FACTORY_DEFAULT_MAX_TOKENS = 8192;

type FptAiFactoryPricing = {
  completion?: string;
  prompt?: string;
  request?: string;
  image?: string;
};

type FptAiFactoryArchitecture = {
  modality?: string;
  input_modalities?: string[];
  output_modalities?: string[];
  tokenizer?: string;
  instruct_type?: string;
};

type FptAiFactoryTopProvider = {
  is_moderated?: boolean;
  context_length?: number | null;
  max_completion_tokens?: number | null;
};

type FptAiFactoryModelEntry = {
  id?: string;
  name?: string;
  canonical_slug?: string;
  created?: number;
  description?: string;
  context_length?: number | null;
  pricing?: FptAiFactoryPricing;
  architecture?: FptAiFactoryArchitecture;
  supported_parameters?: string[];
  top_provider?: FptAiFactoryTopProvider;
};

type FptAiFactoryModelsResponse = {
  data?: FptAiFactoryModelEntry[];
};

export const FPT_AI_FACTORY_FALLBACK_MODEL_CATALOG: ModelDefinitionConfig[] = [
  {
    id: "Qwen3-32B",
    name: "Qwen3-32B",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 33000,
    cost: { input: 0.17, output: 0.19, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "GLM-4.7",
    name: "GLM-4.7",
    reasoning: true,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 8000,
    cost: { input: 0.5, output: 2.2, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "Kimi-K2.5",
    name: "Kimi-K2.5",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 256000,
    maxTokens: 16000,
    cost: { input: 0.5, output: 2.75, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "Qwen3-VL-8B-Instruct",
    name: "Qwen3-VL-8B-Instruct",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 256000,
    maxTokens: 32000,
    cost: { input: 0.2, output: 0.76, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "gpt-oss-120b",
    name: "gpt-oss-120b",
    reasoning: true,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 128000,
    cost: { input: 0.14, output: 0.61, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "SaoLa4-medium",
    name: "SaoLa4-medium",
    reasoning: true,
    input: ["text"],
    contextWindow: FPT_AI_FACTORY_DEFAULT_CONTEXT_WINDOW,
    maxTokens: FPT_AI_FACTORY_DEFAULT_MAX_TOKENS,
    cost: { input: 0.17, output: 0.19, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "SaoLa4-small",
    name: "SaoLa4-small",
    reasoning: true,
    input: ["text"],
    contextWindow: FPT_AI_FACTORY_DEFAULT_CONTEXT_WINDOW,
    maxTokens: FPT_AI_FACTORY_DEFAULT_MAX_TOKENS,
    cost: { input: 0.13, output: 0.15, cacheRead: 0, cacheWrite: 0 },
  },
];

export function buildFptAiFactoryModelDefinition(
  model: ModelDefinitionConfig,
): ModelDefinitionConfig {
  return {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(model.api ? { api: model.api } : {}),
    ...(model.compat ? { compat: model.compat } : {}),
    ...(model.headers ? { headers: model.headers } : {}),
  };
}

function parseCost(value: string | undefined): number {
  if (typeof value !== "string") {
    return 0;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return 0;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return Number((parsed * 1_000_000).toFixed(12));
}

function normalizeName(entry: FptAiFactoryModelEntry): string {
  const candidate =
    (typeof entry.name === "string" && entry.name.trim()) ||
    (typeof entry.id === "string" && entry.id.trim()) ||
    "Unknown model";
  return candidate;
}

function isReasoningModel(entry: FptAiFactoryModelEntry): boolean {
  const haystack = [entry.id, entry.name, entry.canonical_slug, entry.description]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return /(^|\b)(r1|reason|reasoning|thinking|planner|coder)(\b|$)/.test(haystack);
}

function normalizeInput(entry: FptAiFactoryModelEntry): Array<"text" | "image"> | null {
  const modalities = Array.isArray(entry.architecture?.input_modalities)
    ? entry.architecture.input_modalities
    : [];
  const normalized = new Set<"text" | "image">();
  for (const modality of modalities) {
    if (modality === "text") {
      normalized.add("text");
    }
    if (modality === "image") {
      normalized.add("image");
      normalized.add("text");
    }
  }
  if (normalized.size === 0) {
    const modality = entry.architecture?.modality?.toLowerCase() ?? "";
    if (modality.includes("image+text") || modality.includes("vision")) {
      return ["text", "image"];
    }
    if (modality.includes("text")) {
      return ["text"];
    }
    return null;
  }
  return normalized.has("image") ? ["text", "image"] : ["text"];
}

function isChatOrVisionOutput(entry: FptAiFactoryModelEntry): boolean {
  const outputs = Array.isArray(entry.architecture?.output_modalities)
    ? entry.architecture.output_modalities
    : [];
  if (outputs.length === 0) {
    return true;
  }
  return outputs.every((value) => value === "text");
}

const EXCLUDED_KEYWORDS = [
  "embedding",
  "reranker",
  "ocr",
  "tts",
  "whisper",
  "transcription",
  "speech",
  "voice",
  "document-parsing",
  "document parsing",
  "table-parsing",
  "table parsing",
  "kie",
] as const;

function isSupportedInferenceModel(entry: FptAiFactoryModelEntry): boolean {
  const id = typeof entry.id === "string" ? entry.id.trim() : "";
  if (!id) {
    return false;
  }
  const haystack = [entry.id, entry.name, entry.canonical_slug, entry.description]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  if (EXCLUDED_KEYWORDS.some((keyword) => haystack.includes(keyword))) {
    return false;
  }
  if (!isChatOrVisionOutput(entry)) {
    return false;
  }
  return normalizeInput(entry) !== null;
}

function resolveContextWindow(entry: FptAiFactoryModelEntry): number {
  const candidates = [entry.context_length, entry.top_provider?.context_length];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
      return candidate;
    }
  }
  return FPT_AI_FACTORY_DEFAULT_CONTEXT_WINDOW;
}

function resolveMaxTokens(entry: FptAiFactoryModelEntry): number {
  const candidates = [entry.top_provider?.max_completion_tokens, entry.context_length];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
      return candidate;
    }
  }
  return FPT_AI_FACTORY_DEFAULT_MAX_TOKENS;
}

function buildDiscoveredModel(entry: FptAiFactoryModelEntry): ModelDefinitionConfig | null {
  if (!isSupportedInferenceModel(entry)) {
    return null;
  }
  const id = entry.id!.trim();
  const input = normalizeInput(entry);
  if (!input) {
    return null;
  }
  return {
    id,
    name: normalizeName(entry),
    reasoning: isReasoningModel(entry),
    input,
    contextWindow: resolveContextWindow(entry),
    maxTokens: resolveMaxTokens(entry),
    cost: {
      input: parseCost(entry.pricing?.prompt),
      output: parseCost(entry.pricing?.completion),
      cacheRead: 0,
      cacheWrite: 0,
    },
  };
}

function mergeCatalogs(discovered: ModelDefinitionConfig[]): ModelDefinitionConfig[] {
  const byId = new Map<string, ModelDefinitionConfig>();
  for (const model of FPT_AI_FACTORY_FALLBACK_MODEL_CATALOG) {
    byId.set(model.id, buildFptAiFactoryModelDefinition(model));
  }
  for (const model of discovered) {
    const previous = byId.get(model.id);
    byId.set(model.id, {
      ...(previous ?? {}),
      ...model,
      reasoning: model.reasoning || previous?.reasoning || false,
      cost: model.cost,
      input: model.input,
    });
  }
  return [...byId.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export async function discoverFptAiFactoryModels(apiKey: string): Promise<ModelDefinitionConfig[]> {
  const trimmedKey = apiKey.trim();
  if (!trimmedKey) {
    return FPT_AI_FACTORY_FALLBACK_MODEL_CATALOG.map(buildFptAiFactoryModelDefinition);
  }

  try {
    const response = await fetch(`${FPT_AI_FACTORY_BASE_URL}/models`, {
      signal: AbortSignal.timeout(10_000),
      headers: {
        Authorization: `Bearer ${trimmedKey}`,
        "Content-Type": "application/json",
      },
    });
    if (!response.ok) {
      return FPT_AI_FACTORY_FALLBACK_MODEL_CATALOG.map(buildFptAiFactoryModelDefinition);
    }

    const body = (await response.json()) as FptAiFactoryModelsResponse;
    const entries = Array.isArray(body.data) ? body.data : [];
    const discovered = entries
      .map((entry) => buildDiscoveredModel(entry))
      .filter((entry): entry is ModelDefinitionConfig => entry !== null);
    if (discovered.length === 0) {
      return FPT_AI_FACTORY_FALLBACK_MODEL_CATALOG.map(buildFptAiFactoryModelDefinition);
    }
    return mergeCatalogs(discovered);
  } catch (error) {
    return FPT_AI_FACTORY_FALLBACK_MODEL_CATALOG.map(buildFptAiFactoryModelDefinition);
  }
}
