import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";

const log = createSubsystemLogger("qiniu-models");

export const QINIU_BASE_URL = "https://api.qnaigc.com/v1";
export const QINIU_DEFAULT_MODEL_ID = "deepseek-v3";
export const QINIU_DEFAULT_MODEL_REF = `qiniu/${QINIU_DEFAULT_MODEL_ID}`;
export const QINIU_MODELS_URL = `${QINIU_BASE_URL}/models`;

const QINIU_DEFAULT_CONTEXT_WINDOW = 131072;
const QINIU_DEFAULT_MAX_TOKENS = 8192;
const QINIU_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export const QINIU_MODEL_CATALOG: ModelDefinitionConfig[] = [
  {
    id: QINIU_DEFAULT_MODEL_ID,
    name: "DeepSeek V3",
    reasoning: false,
    input: ["text"],
    contextWindow: QINIU_DEFAULT_CONTEXT_WINDOW,
    maxTokens: QINIU_DEFAULT_MAX_TOKENS,
    cost: QINIU_DEFAULT_COST,
  },
];

interface OpenAIModelEntry {
  id?: string;
  owned_by?: string;
}

interface OpenAIListModelsResponse {
  data?: OpenAIModelEntry[];
}

function buildStaticCatalog(): ModelDefinitionConfig[] {
  return QINIU_MODEL_CATALOG.map(buildQiniuModelDefinition);
}

function toModelDefinition(id: string): ModelDefinitionConfig {
  return {
    id,
    name: id,
    api: "openai-completions",
    reasoning: id.toLowerCase().includes("r1") || id.toLowerCase().includes("reason"),
    input: ["text"],
    contextWindow: QINIU_DEFAULT_CONTEXT_WINDOW,
    maxTokens: QINIU_DEFAULT_MAX_TOKENS,
    cost: QINIU_DEFAULT_COST,
  };
}

function cacheAndMergeDiscoveredModels(models: ModelDefinitionConfig[]): ModelDefinitionConfig[] {
  if (models.length === 0) {
    return buildStaticCatalog();
  }
  const discovered = new Set(models.map((model) => model.id));
  const merged = [...models];
  for (const fallbackModel of buildStaticCatalog()) {
    if (!discovered.has(fallbackModel.id)) {
      merged.unshift(fallbackModel);
    }
  }
  return merged;
}

export async function discoverQiniuModels(apiKey?: string): Promise<ModelDefinitionConfig[]> {
  if (process.env.NODE_ENV === "test" || process.env.VITEST === "true") {
    return buildStaticCatalog();
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  const normalizedApiKey = normalizeOptionalString(apiKey);
  if (normalizedApiKey) {
    headers.Authorization = `Bearer ${normalizedApiKey}`;
  }

  try {
    const response = await fetch(QINIU_MODELS_URL, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      if (response.status !== 401 && response.status !== 429) {
        log.warn(`GET /v1/models failed: HTTP ${response.status}, using static catalog`);
      }
      return buildStaticCatalog();
    }

    const body = (await response.json()) as OpenAIListModelsResponse;
    const data = body?.data;
    if (!Array.isArray(data) || data.length === 0) {
      return buildStaticCatalog();
    }

    const seen = new Set<string>();
    const models: ModelDefinitionConfig[] = [];
    for (const entry of data) {
      const id = normalizeOptionalString(entry?.id) ?? "";
      if (!id || seen.has(id)) {
        continue;
      }
      seen.add(id);
      models.push(toModelDefinition(id));
    }

    return cacheAndMergeDiscoveredModels(models);
  } catch (error) {
    log.warn(`Discovery failed: ${String(error)}, using static catalog`);
    return buildStaticCatalog();
  }
}

export function buildQiniuModelDefinition(
  model: (typeof QINIU_MODEL_CATALOG)[number],
): ModelDefinitionConfig {
  return {
    ...model,
    api: "openai-completions",
  };
}
