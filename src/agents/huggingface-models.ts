import type { ModelDefinitionConfig } from "../config/types.models.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("huggingface-models");

/** Hugging Face Inference Providers (router) — OpenAI-compatible chat completions. */
export const HUGGINGFACE_BASE_URL = "https://router.huggingface.co/v1";

/** Router policy suffixes: router picks backend by cost or speed; no specific provider selection. */
export const HUGGINGFACE_POLICY_SUFFIXES = ["cheapest", "fastest"] as const;

/**
 * True when the model ref uses :cheapest or :fastest. When true, provider choice is locked
 * (router decides); do not show an interactive "prefer specific backend" option.
 */
export function isHuggingfacePolicyLocked(modelRef: string): boolean {
  const ref = String(modelRef).trim();
  return HUGGINGFACE_POLICY_SUFFIXES.some((s) => ref.endsWith(`:${s}`) || ref === s);
}

/**
 * Model id safe for the Hugging Face Inference API (router.huggingface.co).
 * Per HF docs, the API expects Hub-style model ids (e.g. deepseek-ai/DeepSeek-R1) with
 * optional routing suffixes (:cheapest, :fastest, or :provider). The "huggingface/" prefix
 * is OpenClaw-internal and must not be sent to the HF client.
 * Returns the same string with a leading "huggingface/" stripped; other tags are preserved.
 */
export function modelIdForHfInferenceClient(modelRefOrId: string): string {
  const s = String(modelRefOrId).trim();
  const prefix = "huggingface/";
  const lowerS = s.toLowerCase();
  if (lowerS.startsWith(prefix)) {
    return s.slice(lowerS.indexOf(prefix) + prefix.length).trim() || s;
  }
  return s;
}

/** Default cost when not in static catalog (HF pricing varies by provider). */
const HUGGINGFACE_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

/** Defaults for models discovered from GET /v1/models. */
const HUGGINGFACE_DEFAULT_CONTEXT_WINDOW = 131072;
const HUGGINGFACE_DEFAULT_MAX_TOKENS = 8192;

/**
 * Shape of a single model entry from GET https://router.huggingface.co/v1/models.
 * Aligned with the Inference Providers API response (object, data[].id, owned_by, architecture, providers).
 */
interface HFModelEntry {
  id: string;
  object?: string;
  created?: number;
  /** Organisation that owns the model (e.g. "Qwen", "deepseek-ai"). Used for display when name/title absent. */
  owned_by?: string;
  /** Display name from API when present (not all responses include this). */
  name?: string;
  title?: string;
  display_name?: string;
  /** Input/output modalities; we use input_modalities for ModelDefinitionConfig.input. */
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
    [key: string]: unknown;
  };
  /** Backend providers; we use the first provider with context_length when available. */
  providers?: Array<{
    provider?: string;
    context_length?: number;
    status?: string;
    pricing?: { input?: number; output?: number; [key: string]: unknown };
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

/** Response shape from GET https://router.huggingface.co/v1/models (OpenAI-style list). */
interface OpenAIListModelsResponse {
  object?: string;
  data?: HFModelEntry[];
}

export const HUGGINGFACE_MODEL_CATALOG: ModelDefinitionConfig[] = [
  {
    id: "deepseek-ai/DeepSeek-R1",
    name: "DeepSeek R1",
    reasoning: true,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
    cost: { input: 3.0, output: 7.0, cacheRead: 3.0, cacheWrite: 3.0 },
  },
  {
    id: "deepseek-ai/DeepSeek-V3.1",
    name: "DeepSeek V3.1",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
    cost: { input: 0.6, output: 1.25, cacheRead: 0.6, cacheWrite: 0.6 },
  },
  {
    id: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    name: "Llama 3.3 70B Instruct Turbo",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
    cost: { input: 0.88, output: 0.88, cacheRead: 0.88, cacheWrite: 0.88 },
  },
  {
    id: "openai/gpt-oss-120b",
    name: "GPT-OSS 120B",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
];

export function buildHuggingfaceModelDefinition(
  model: (typeof HUGGINGFACE_MODEL_CATALOG)[number],
): ModelDefinitionConfig {
  return {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

/**
 * Infer reasoning and display name from Hub-style model id (e.g. "deepseek-ai/DeepSeek-R1").
 */
function inferredMetaFromModelId(id: string): { name: string; reasoning: boolean } {
  const base = id.split("/").pop() ?? id;
  const reasoning = /r1|reasoning|thinking|reason/i.test(id) || /-\d+[tb]?-thinking/i.test(base);
  const name = base.replace(/-/g, " ").replace(/\b(\w)/g, (c) => c.toUpperCase());
  return { name, reasoning };
}

/** Prefer API-supplied display name, then owned_by/id, then inferred from id. */
function displayNameFromApiEntry(entry: HFModelEntry, inferredName: string): string {
  const fromApi =
    (typeof entry.name === "string" && entry.name.trim()) ||
    (typeof entry.title === "string" && entry.title.trim()) ||
    (typeof entry.display_name === "string" && entry.display_name.trim());
  if (fromApi) {
    return fromApi;
  }
  if (typeof entry.owned_by === "string" && entry.owned_by.trim()) {
    const base = entry.id.split("/").pop() ?? entry.id;
    return `${entry.owned_by.trim()}/${base}`;
  }
  return inferredName;
}

/**
 * Discover chat-completion models from Hugging Face Inference Providers (GET /v1/models).
 * Requires a valid HF token. Falls back to static catalog on failure or in test env.
 */
export async function discoverHuggingfaceModels(apiKey: string): Promise<ModelDefinitionConfig[]> {
  if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
    return HUGGINGFACE_MODEL_CATALOG.map(buildHuggingfaceModelDefinition);
  }

  const trimmedKey = apiKey?.trim();
  if (!trimmedKey) {
    return HUGGINGFACE_MODEL_CATALOG.map(buildHuggingfaceModelDefinition);
  }

  try {
    // GET https://router.huggingface.co/v1/models — response: { object, data: [{ id, owned_by, architecture: { input_modalities }, providers: [{ provider, context_length?, pricing? }] }] }. POST /v1/chat/completions requires Authorization.
    const response = await fetch(`${HUGGINGFACE_BASE_URL}/models`, {
      signal: AbortSignal.timeout(10_000),
      headers: {
        Authorization: `Bearer ${trimmedKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      log.warn(`GET /v1/models failed: HTTP ${response.status}, using static catalog`);
      return HUGGINGFACE_MODEL_CATALOG.map(buildHuggingfaceModelDefinition);
    }

    const body = (await response.json()) as OpenAIListModelsResponse;
    const data = body?.data;
    if (!Array.isArray(data) || data.length === 0) {
      log.warn("No models in response, using static catalog");
      return HUGGINGFACE_MODEL_CATALOG.map(buildHuggingfaceModelDefinition);
    }

    const catalogById = new Map(HUGGINGFACE_MODEL_CATALOG.map((m) => [m.id, m] as const));
    const seen = new Set<string>();
    const models: ModelDefinitionConfig[] = [];

    for (const entry of data) {
      const id = typeof entry?.id === "string" ? entry.id.trim() : "";
      if (!id || seen.has(id)) {
        continue;
      }
      seen.add(id);

      const catalogEntry = catalogById.get(id);
      if (catalogEntry) {
        models.push(buildHuggingfaceModelDefinition(catalogEntry));
      } else {
        const inferred = inferredMetaFromModelId(id);
        const name = displayNameFromApiEntry(entry, inferred.name);
        const modalities = entry.architecture?.input_modalities;
        const input: Array<"text" | "image"> =
          Array.isArray(modalities) && modalities.includes("image") ? ["text", "image"] : ["text"];
        const providers = Array.isArray(entry.providers) ? entry.providers : [];
        const providerWithContext = providers.find(
          (p) => typeof p?.context_length === "number" && p.context_length > 0,
        );
        const contextLength =
          providerWithContext?.context_length ?? HUGGINGFACE_DEFAULT_CONTEXT_WINDOW;
        models.push({
          id,
          name,
          reasoning: inferred.reasoning,
          input,
          cost: HUGGINGFACE_DEFAULT_COST,
          contextWindow: contextLength,
          maxTokens: HUGGINGFACE_DEFAULT_MAX_TOKENS,
        });
      }
    }

    return models.length > 0
      ? models
      : HUGGINGFACE_MODEL_CATALOG.map(buildHuggingfaceModelDefinition);
  } catch (error) {
    log.warn(`Discovery failed: ${String(error)}, using static catalog`);
    return HUGGINGFACE_MODEL_CATALOG.map(buildHuggingfaceModelDefinition);
  }
}
