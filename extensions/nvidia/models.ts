import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";

export const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
export const NVIDIA_DISCOVERY_TIMEOUT_MS = 30_000;

const NVIDIA_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

const NVIDIA_DEFAULT_CONTEXT_WINDOW = 131072;
const NVIDIA_DEFAULT_MAX_TOKENS = 8192;

export const NVIDIA_CATALOGED_MODELS: ModelDefinitionConfig[] = [
  {
    id: "nvidia/nemotron-3-super-120b-a12b",
    name: "NVIDIA Nemotron 3 Super 120B",
    reasoning: false,
    input: ["text"],
    contextWindow: 262144,
    maxTokens: NVIDIA_DEFAULT_MAX_TOKENS,
    cost: NVIDIA_DEFAULT_COST,
  },
  {
    id: "nvidia/nemotron-3-8b-instruct",
    name: "NVIDIA Nemotron 3 8B Instruct",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: NVIDIA_DEFAULT_MAX_TOKENS,
    cost: NVIDIA_DEFAULT_COST,
  },
  {
    id: "nvidia/nemotron-4-340b-instruct",
    name: "NVIDIA Nemotron 4 340B Instruct",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: NVIDIA_DEFAULT_MAX_TOKENS,
    cost: NVIDIA_DEFAULT_COST,
  },
  {
    id: "nvidia/llama-3.1-nemotron-ultra-253b-v1",
    name: "NVIDIA Llama 3.1 Nemotron Ultra 253B",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: NVIDIA_DEFAULT_MAX_TOKENS,
    cost: NVIDIA_DEFAULT_COST,
  },
  {
    id: "nvidia/meta/llama-4-maverick-17b-128e-instruct",
    name: "Meta Llama 4 Maverick 17B 128E Instruct",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 131072,
    maxTokens: NVIDIA_DEFAULT_MAX_TOKENS,
    cost: NVIDIA_DEFAULT_COST,
  },
  {
    id: "nvidia/meta/llama-4-scout-17b-16e-instruct",
    name: "Meta Llama 4 Scout 17B 16E Instruct",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 131072,
    maxTokens: NVIDIA_DEFAULT_MAX_TOKENS,
    cost: NVIDIA_DEFAULT_COST,
  },
];

const REASONING_KEYWORDS = [
  "r1",
  "reason",
  "thinking",
  "reasoner",
  "qwq",
] as const;

function isReasoningModelHeuristic(modelId: string): boolean {
  const lower = normalizeLowercaseStringOrEmpty(modelId);
  return REASONING_KEYWORDS.some((keyword) => lower.includes(keyword));
}

type NVIDIAModelEntry = {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
};

type OpenAIListModelsResponse = {
  data?: NVIDIAModelEntry[];
};

function isInferenceModel(entry: NVIDIAModelEntry): boolean {
  const id = entry.id?.trim() ?? "";

  if (id.includes("nemoretriever") || id.includes("embed") || id.includes("clip")) {
    return false;
  }

  if (id.includes("reward") || id.includes("content-safety") || id.includes("guard")) {
    return false;
  }

  if (id.includes("parse") || id.includes("gliner") || id.includes("ising")) {
    return false;
  }

  return true;
}

function inferredMetaFromModelId(id: string): { name: string; reasoning: boolean; contextWindow?: number } {
  const parts = id.split("/");
  const base = parts.pop() ?? id;
  const owner = parts.pop() ?? "";
  const reasoning = isReasoningModelHeuristic(id);

  let contextWindow: number | undefined;
  const lower = normalizeLowercaseStringOrEmpty(base);
  if (lower.includes("ultra-253b") || lower.includes("super-120b")) {
    contextWindow = 262144;
  } else if (lower.includes("340b")) {
    contextWindow = 131072;
  } else if (lower.includes("70b") || lower.includes("49b")) {
    contextWindow = 131072;
  } else if (lower.includes("8b") || lower.includes("12b")) {
    contextWindow = 131072;
  }

  const name = base.replace(/[-_]/g, " ").replace(/\b(\w)/g, (c) => c.toUpperCase());
  const displayName = owner ? `${owner} ${name}` : name;
  return { name: displayName, reasoning, contextWindow };
}

export function buildNvidiaModelDefinition(model: ModelDefinitionConfig): ModelDefinitionConfig {
  return {
    ...model,
    api: "openai-completions",
  };
}

export async function discoverNvidiaModels(
  apiKey: string,
  timeoutMs = NVIDIA_DISCOVERY_TIMEOUT_MS,
): Promise<ModelDefinitionConfig[]> {
  if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
    return NVIDIA_CATALOGED_MODELS.map(buildNvidiaModelDefinition);
  }

  const trimmedKey = apiKey?.trim();
  if (!trimmedKey) {
    return NVIDIA_CATALOGED_MODELS.map(buildNvidiaModelDefinition);
  }

  try {
    const response = await fetch(`${NVIDIA_BASE_URL}/models`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Authorization: `Bearer ${trimmedKey}`,
        "Content-Type": "application/json",
      },
    });
    if (!response.ok) {
      return NVIDIA_CATALOGED_MODELS.map(buildNvidiaModelDefinition);
    }

    const body = (await response.json()) as OpenAIListModelsResponse;
    const data = body?.data;
    if (!Array.isArray(data) || data.length === 0) {
      return NVIDIA_CATALOGED_MODELS.map(buildNvidiaModelDefinition);
    }

    const catalogById = new Map(
      NVIDIA_CATALOGED_MODELS.map((model) => [model.id, model] as const),
    );
    const seen = new Set<string>();
    const models: ModelDefinitionConfig[] = [];

    for (const entry of data) {
      const id = typeof entry?.id === "string" ? entry.id.trim() : "";
      if (!id || seen.has(id)) {
        continue;
      }

      if (!isInferenceModel(entry)) {
        continue;
      }

      seen.add(id);

      const catalogEntry = catalogById.get(id);
      if (catalogEntry) {
        models.push(buildNvidiaModelDefinition(catalogEntry));
        continue;
      }

      const inferred = inferredMetaFromModelId(id);
      models.push({
        id,
        name: inferred.name,
        reasoning: inferred.reasoning,
        input: ["text"],
        cost: NVIDIA_DEFAULT_COST,
        contextWindow: inferred.contextWindow ?? NVIDIA_DEFAULT_CONTEXT_WINDOW,
        maxTokens: NVIDIA_DEFAULT_MAX_TOKENS,
      });
    }

    return models.length > 0
      ? models
      : NVIDIA_CATALOGED_MODELS.map(buildNvidiaModelDefinition);
  } catch {
    return NVIDIA_CATALOGED_MODELS.map(buildNvidiaModelDefinition);
  }
}
