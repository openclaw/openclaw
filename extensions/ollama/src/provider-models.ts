import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-onboard";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  OLLAMA_DEFAULT_BASE_URL,
  OLLAMA_DEFAULT_CONTEXT_WINDOW,
  OLLAMA_DEFAULT_COST,
  OLLAMA_DEFAULT_MAX_TOKENS,
} from "./defaults.js";

/**
 * Suggested cloud model IDs to append when using ollama.com as the API base.
 * These models are not returned by /api/tags and must be added explicitly.
 */
export const OLLAMA_SUGGESTED_CLOUD_MODELS = [
  "gemma4:31b-cloud",
  "kimi-k2.5:cloud",
  "minimax-m2.7:cloud",
  "glm-5.1:cloud",
];

/**
 * Static capabilities for Ollama cloud models, sourced from
 * https://ollama.com/search?c=cloud model capability badges.
 *
 * Keep this list aligned with capabilities that OpenClaw can actually route
 * through documented Ollama APIs today. Ollama documents vision/image inputs,
 * but not audio input or OpenAI-style audio transcription endpoints yet.
 * Keys are model IDs without the `:cloud` suffix.
 */
export const OLLAMA_CLOUD_MODEL_CAPABILITIES: Record<string, string[]> = {
  "gemma4:31b-cloud": ["vision", "tools", "thinking"],
  "kimi-k2.5:cloud": ["vision", "tools", "thinking"],
  "minimax-m2.7:cloud": ["tools", "thinking"],
  "glm-5:cloud": ["tools", "thinking"],
  "glm-5.1:cloud": ["tools", "thinking"],
  "qwen3.5:cloud": ["vision", "tools"],
  "qwen3-coder-next:cloud": ["tools"],
  "devstral-small-2:cloud": ["vision", "tools"],
  "devstral-2:cloud": ["tools"],
  "nemotron-3-super:cloud": ["tools", "thinking"],
  "qwen3-next:cloud": ["tools", "thinking"],
  "rnj-1:cloud": ["tools"],
  "nemotron-3-nano:cloud": ["tools", "thinking"],
  "minimax-m2.5:cloud": ["tools", "thinking"],
  "gemini-3-flash-preview:cloud": ["vision", "tools", "thinking"],
  "glm-4.7:cloud": ["tools", "thinking"],
  "deepseek-v3.2:cloud": ["tools", "thinking"],
  "minimax-m2:cloud": ["tools", "thinking"],
  "ministral-3:cloud": ["vision", "tools"],
};

/**
 * Resolve capabilities for a cloud model ID.
 * Falls back to the static map, then to an empty array.
 */
export function resolveOllamaCloudModelCapabilities(modelId: string): string[] {
  return OLLAMA_CLOUD_MODEL_CAPABILITIES[modelId] ?? [];
}

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
  capabilities?: string[];
};

const OLLAMA_SHOW_CONCURRENCY = 8;
const MAX_OLLAMA_SHOW_CACHE_ENTRIES = 256;
const ollamaModelShowInfoCache = new Map<string, Promise<OllamaModelShowInfo>>();
const OLLAMA_ALWAYS_BLOCKED_HOSTNAMES = new Set(["metadata.google.internal"]);

export function buildOllamaBaseUrlSsrFPolicy(baseUrl: string) {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    if (OLLAMA_ALWAYS_BLOCKED_HOSTNAMES.has(parsed.hostname)) {
      return undefined;
    }
    return {
      hostnameAllowlist: [parsed.hostname],
      allowPrivateNetwork: true,
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

export type OllamaModelShowInfo = {
  contextWindow?: number;
  capabilities?: string[];
};

function buildOllamaModelShowCacheKey(
  apiBase: string,
  model: Pick<OllamaTagModel, "name" | "digest" | "modified_at">,
): string | undefined {
  const version = model.digest?.trim() || model.modified_at?.trim();
  if (!version) {
    return undefined;
  }
  return `${resolveOllamaApiBase(apiBase)}|${model.name}|${version}`;
}

function setOllamaModelShowCacheEntry(key: string, value: Promise<OllamaModelShowInfo>): void {
  if (ollamaModelShowInfoCache.size >= MAX_OLLAMA_SHOW_CACHE_ENTRIES) {
    const oldestKey = ollamaModelShowInfoCache.keys().next().value;
    if (typeof oldestKey === "string") {
      ollamaModelShowInfoCache.delete(oldestKey);
    }
  }
  ollamaModelShowInfoCache.set(key, value);
}

function hasCachedOllamaModelShowInfo(info: OllamaModelShowInfo): boolean {
  return typeof info.contextWindow === "number" || (info.capabilities?.length ?? 0) > 0;
}

export async function queryOllamaModelShowInfo(
  apiBase: string,
  modelName: string,
  apiKey?: string,
): Promise<OllamaModelShowInfo> {
  const normalizedApiBase = resolveOllamaApiBase(apiBase);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
    const { response, release } = await fetchWithSsrFGuard({
      url: `${normalizedApiBase}/api/show`,
      init: {
        method: "POST",
        headers,
        body: JSON.stringify({ name: modelName }),
        signal: AbortSignal.timeout(3000),
      },
      policy: buildOllamaBaseUrlSsrFPolicy(normalizedApiBase),
      auditContext: "ollama-provider-models.show",
    });
    try {
      if (!response.ok) {
        return {};
      }
      const data = (await response.json()) as {
        model_info?: Record<string, unknown>;
        capabilities?: unknown;
      };

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

      const capabilities = Array.isArray(data.capabilities)
        ? (data.capabilities as unknown[]).filter((c): c is string => typeof c === "string")
        : undefined;

      return { contextWindow, capabilities };
    } finally {
      await release();
    }
  } catch {
    return {};
  }
}

async function queryOllamaModelShowInfoCached(
  apiBase: string,
  model: Pick<OllamaTagModel, "name" | "digest" | "modified_at">,
  apiKey?: string,
): Promise<OllamaModelShowInfo> {
  const normalizedApiBase = resolveOllamaApiBase(apiBase);
  const cacheKey = buildOllamaModelShowCacheKey(normalizedApiBase, model);
  if (!cacheKey) {
    return await queryOllamaModelShowInfo(normalizedApiBase, model.name, apiKey);
  }

  const cached = ollamaModelShowInfoCache.get(cacheKey);
  if (cached) {
    return await cached;
  }

  const pending = queryOllamaModelShowInfo(normalizedApiBase, model.name, apiKey).then((result) => {
    if (!hasCachedOllamaModelShowInfo(result)) {
      ollamaModelShowInfoCache.delete(cacheKey);
    }
    return result;
  });
  setOllamaModelShowCacheEntry(cacheKey, pending);
  return await pending;
}

/** @deprecated Use queryOllamaModelShowInfo instead. */
export async function queryOllamaContextWindow(
  apiBase: string,
  modelName: string,
): Promise<number | undefined> {
  return (await queryOllamaModelShowInfo(apiBase, modelName)).contextWindow;
}

export async function enrichOllamaModelsWithContext(
  apiBase: string,
  models: OllamaTagModel[],
  opts?: { concurrency?: number; apiKey?: string },
): Promise<OllamaModelWithContext[]> {
  const concurrency = Math.max(1, Math.floor(opts?.concurrency ?? OLLAMA_SHOW_CONCURRENCY));
  const apiKey = opts?.apiKey;
  const enriched: OllamaModelWithContext[] = [];
  for (let index = 0; index < models.length; index += concurrency) {
    const batch = models.slice(index, index + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (model) => {
        const showInfo = await queryOllamaModelShowInfoCached(apiBase, model, apiKey);
        return {
          ...model,
          contextWindow: showInfo.contextWindow,
          capabilities: showInfo.capabilities,
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
  capabilities?: string[],
): ModelDefinitionConfig {
  const hasVision = capabilities?.includes("vision") ?? false;
  const hasThinking = capabilities?.includes("thinking") ?? false;
  const input: ("text" | "image")[] = hasVision ? ["text", "image"] : ["text"];
  return {
    id: modelId,
    name: modelId,
    reasoning: hasThinking || isReasoningModelHeuristic(modelId),
    input,
    cost: OLLAMA_DEFAULT_COST,
    contextWindow: contextWindow ?? OLLAMA_DEFAULT_CONTEXT_WINDOW,
    maxTokens: OLLAMA_DEFAULT_MAX_TOKENS,
  };
}

export async function fetchOllamaModels(
  baseUrl: string,
  apiKey?: string,
): Promise<{ reachable: boolean; models: OllamaTagModel[] }> {
  try {
    const apiBase = resolveOllamaApiBase(baseUrl);
    const headers: Record<string, string> = {};
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
    const { response, release } = await fetchWithSsrFGuard({
      url: `${apiBase}/api/tags`,
      init: {
        headers,
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

export function resetOllamaModelShowInfoCacheForTest(): void {
  ollamaModelShowInfoCache.clear();
}

export async function checkOllamaCloudAuth(
  baseUrl: string,
  apiKey?: string,
): Promise<{ signedIn: boolean; signinUrl?: string }> {
  try {
    const apiBase = resolveOllamaApiBase(baseUrl);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
    const { response, release } = await fetchWithSsrFGuard({
      url: `${apiBase}/api/me`,
      init: {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(5000),
      },
      policy: buildOllamaBaseUrlSsrFPolicy(apiBase),
      auditContext: "ollama-provider-models.me",
    });
    try {
      if (response.status === 401) {
        const data = (await response.json()) as { signin_url?: string };
        return { signedIn: false, signinUrl: data.signin_url };
      }
      if (!response.ok) {
        return { signedIn: false };
      }
      return { signedIn: true };
    } finally {
      await release();
    }
  } catch {
    return { signedIn: false };
  }
}
