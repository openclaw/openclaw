import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-onboard";
import { fetchWithSsrFGuard, type SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  OLLAMA_DEFAULT_BASE_URL,
  OLLAMA_DEFAULT_CONTEXT_WINDOW,
  OLLAMA_DEFAULT_COST,
  OLLAMA_DEFAULT_MAX_TOKENS,
} from "./defaults.js";

export type OllamaTagModel = {
  name: string;
  modified_at?: string;
  size?: number;
  digest?: string;
  remote_host?: string;
  details?: {
    family?: string;
    parameter_size?: string;
  };
};

export type OllamaTagsResponse = {
  models?: OllamaTagModel[];
};

export type OllamaModelWithContext = OllamaTagModel & {
  contextWindow?: number;
  vision?: boolean;
};

type OllamaShowResponse = {
  model_info?: Record<string, unknown>;
  details?: {
    family?: string;
    families?: string[];
    parameter_size?: string;
  };
};

export type OllamaModelMeta = {
  contextWindow?: number;
  vision?: boolean;
};

const OLLAMA_SHOW_CONCURRENCY = 8;

// Vision models surface a CLIP or cross-attention encoder in /api/show as keys
// like "clip.has_vision_encoder" or "mllama.vision.image_size", and as "clip" or
// "mllama" in details.families.
const VISION_MODEL_INFO_KEY_RE = /^clip\.|\.vision\./;
const VISION_FAMILIES = new Set(["clip", "mllama"]);

export function detectVisionFromShowResponse(data: OllamaShowResponse): boolean {
  if (data.model_info) {
    for (const key of Object.keys(data.model_info)) {
      if (VISION_MODEL_INFO_KEY_RE.test(key)) {
        return true;
      }
    }
  }
  if (Array.isArray(data.details?.families)) {
    if (data.details.families.some((f) => VISION_FAMILIES.has(f.toLowerCase()))) {
      return true;
    }
  }
  return false;
}

export function isVisionModelHeuristic(modelId: string): boolean {
  return /\bvl\b|llava|vision|moondream|minicpm-v|pixtral|internvl/i.test(modelId);
}

export function buildOllamaBaseUrlSsrFPolicy(baseUrl: string): SsrFPolicy | undefined {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return {
      allowedHostnames: [parsed.hostname],
      hostnameAllowlist: [parsed.hostname],
    };
  } catch {
    return undefined;
  }
}

export function resolveOllamaApiBase(configuredBaseUrl?: string): string {
  if (!configuredBaseUrl) {
    return OLLAMA_DEFAULT_BASE_URL;
  }
  const trimmed = configuredBaseUrl.replace(/\/+$/, "");
  return trimmed.replace(/\/v1$/i, "");
}

export async function queryOllamaModelMeta(
  apiBase: string,
  modelName: string,
): Promise<OllamaModelMeta> {
  try {
    const { response, release } = await fetchWithSsrFGuard({
      url: `${apiBase}/api/show`,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: modelName }),
        signal: AbortSignal.timeout(3000),
      },
      policy: buildOllamaBaseUrlSsrFPolicy(apiBase),
      auditContext: "ollama-provider-models.show",
    });
    try {
      if (!response.ok) {
        return {};
      }
      const data = (await response.json()) as OllamaShowResponse;
      let contextWindow: number | undefined;
      if (data.model_info) {
        for (const [key, value] of Object.entries(data.model_info)) {
          if (
            key.endsWith(".context_length") &&
            typeof value === "number" &&
            Number.isFinite(value)
          ) {
            const ctx = Math.floor(value);
            if (ctx > 0) {
              contextWindow = ctx;
              break;
            }
          }
        }
      }
      const vision = detectVisionFromShowResponse(data);
      return { contextWindow, vision: vision || undefined };
    } finally {
      await release();
    }
  } catch {
    return {};
  }
}

/** @deprecated Use {@link queryOllamaModelMeta} for richer metadata. */
export async function queryOllamaContextWindow(
  apiBase: string,
  modelName: string,
): Promise<number | undefined> {
  const meta = await queryOllamaModelMeta(apiBase, modelName);
  return meta.contextWindow;
}

export async function enrichOllamaModelsWithContext(
  apiBase: string,
  models: OllamaTagModel[],
  opts?: { concurrency?: number },
): Promise<OllamaModelWithContext[]> {
  const concurrency = Math.max(1, Math.floor(opts?.concurrency ?? OLLAMA_SHOW_CONCURRENCY));
  const enriched: OllamaModelWithContext[] = [];
  for (let index = 0; index < models.length; index += concurrency) {
    const batch = models.slice(index, index + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (model) => {
        const meta = await queryOllamaModelMeta(apiBase, model.name);
        return {
          ...model,
          contextWindow: meta.contextWindow,
          vision: meta.vision,
        };
      }),
    );
    enriched.push(...batchResults);
  }
  return enriched;
}

export function isReasoningModelHeuristic(modelId: string): boolean {
  return /r1|reasoning|think|reason/i.test(modelId);
}

export function buildOllamaModelDefinition(
  modelId: string,
  contextWindow?: number,
  opts?: { vision?: boolean },
): ModelDefinitionConfig {
  // Combine API-detected vision capability with name heuristic for maximum
  // coverage: the /api/show metadata is authoritative when available, the
  // heuristic catches models whose architecture metadata is missing or novel.
  const vision = opts?.vision || isVisionModelHeuristic(modelId);
  return {
    id: modelId,
    name: modelId,
    reasoning: isReasoningModelHeuristic(modelId),
    input: vision ? ["text", "image"] : ["text"],
    cost: OLLAMA_DEFAULT_COST,
    contextWindow: contextWindow ?? OLLAMA_DEFAULT_CONTEXT_WINDOW,
    maxTokens: OLLAMA_DEFAULT_MAX_TOKENS,
  };
}

export async function fetchOllamaModels(
  baseUrl: string,
): Promise<{ reachable: boolean; models: OllamaTagModel[] }> {
  try {
    const apiBase = resolveOllamaApiBase(baseUrl);
    const { response, release } = await fetchWithSsrFGuard({
      url: `${apiBase}/api/tags`,
      init: {
        signal: AbortSignal.timeout(5000),
      },
      policy: buildOllamaBaseUrlSsrFPolicy(apiBase),
      auditContext: "ollama-provider-models.tags",
    });
    try {
      if (!response.ok) {
        return { reachable: true, models: [] };
      }
      const data = (await response.json()) as OllamaTagsResponse;
      const models = (data.models ?? []).filter((m) => m.name);
      return { reachable: true, models };
    } finally {
      await release();
    }
  } catch {
    return { reachable: false, models: [] };
  }
}
