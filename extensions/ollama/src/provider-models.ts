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
};

const OLLAMA_SHOW_CONCURRENCY = 8;

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

export async function queryOllamaContextWindow(
  apiBase: string,
  modelName: string,
): Promise<number | undefined> {
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
        return undefined;
      }
      const data = (await response.json()) as { model_info?: Record<string, unknown> };
      if (!data.model_info) {
        return undefined;
      }
      for (const [key, value] of Object.entries(data.model_info)) {
        if (
          key.endsWith(".context_length") &&
          typeof value === "number" &&
          Number.isFinite(value)
        ) {
          const contextWindow = Math.floor(value);
          if (contextWindow > 0) {
            return contextWindow;
          }
        }
      }
      return undefined;
    } finally {
      await release();
    }
  } catch {
    return undefined;
  }
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
      batch.map(async (model) => ({
        ...model,
        contextWindow: await queryOllamaContextWindow(apiBase, model.name),
      })),
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
): ModelDefinitionConfig {
  return {
    id: modelId,
    name: modelId,
    reasoning: isReasoningModelHeuristic(modelId),
    input: ["text"],
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
