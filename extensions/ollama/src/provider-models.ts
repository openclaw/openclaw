import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-onboard";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
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

// Ollama's /api/show returns Modelfile PARAMETER overrides as a newline
// delimited string (e.g. "num_ctx 32768\nnum_keep 5"). Extract the last
// positive integer value for `num_ctx`, matching Ollama's own last-wins
// semantics when a Modelfile lists the parameter more than once.
export function parseOllamaNumCtxParameter(parameters: unknown): number | undefined {
  if (typeof parameters !== "string" || !parameters.trim()) {
    return undefined;
  }
  let lastValue: number | undefined;
  for (const rawLine of parameters.split(/\r?\n/)) {
    const match = rawLine.trim().match(/^num_ctx\s+(-?\d+)\b/);
    if (!match) {
      continue;
    }
    const parsed = Number.parseInt(match[1], 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      lastValue = parsed;
    }
  }
  return lastValue;
}

export async function queryOllamaModelShowInfo(
  apiBase: string,
  modelName: string,
): Promise<OllamaModelShowInfo> {
  const normalizedApiBase = resolveOllamaApiBase(apiBase);
  try {
    const { response, release } = await fetchWithSsrFGuard({
      url: `${normalizedApiBase}/api/show`,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
        parameters?: unknown;
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
      // Modelfile `PARAMETER num_ctx <value>` can raise the effective context
      // above the base model's native `context_length` (e.g. a custom
      // Modelfile with `PARAMETER num_ctx 32768` on top of llama3 8k). Use it
      // only when it would expand capacity — pulled base Modelfiles sometimes
      // ship a small default `num_ctx` that must not under-report models with
      // a larger native `context_length`. Users who want a strictly lower
      // context should configure it explicitly under
      // `models.providers.ollama.models[].contextWindow`.
      const paramCtx = parseOllamaNumCtxParameter(data.parameters);
      if (paramCtx !== undefined && (contextWindow === undefined || paramCtx > contextWindow)) {
        contextWindow = paramCtx;
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
): Promise<OllamaModelShowInfo> {
  const normalizedApiBase = resolveOllamaApiBase(apiBase);
  const cacheKey = buildOllamaModelShowCacheKey(normalizedApiBase, model);
  if (!cacheKey) {
    return await queryOllamaModelShowInfo(normalizedApiBase, model.name);
  }

  const cached = ollamaModelShowInfoCache.get(cacheKey);
  if (cached) {
    return await cached;
  }

  const pending = queryOllamaModelShowInfo(normalizedApiBase, model.name).then((result) => {
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
  opts?: { concurrency?: number },
): Promise<OllamaModelWithContext[]> {
  const concurrency = Math.max(1, Math.floor(opts?.concurrency ?? OLLAMA_SHOW_CONCURRENCY));
  const enriched: OllamaModelWithContext[] = [];
  for (let index = 0; index < models.length; index += concurrency) {
    const batch = models.slice(index, index + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (model) => {
        const showInfo = await queryOllamaModelShowInfoCached(apiBase, model);
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
  const input: ("text" | "image")[] = hasVision ? ["text", "image"] : ["text"];
  // When /api/show returns a non-empty capabilities array that does not list
  // "tools", trust Ollama's own capability signal and flag the model as
  // non-tool-supporting so the agent falls back to plain chat instead of
  // failing with a "does not support tools" error. Leave compat undefined
  // when capabilities are missing, preserving the existing permissive default.
  const hasCapabilitySignal = Array.isArray(capabilities) && capabilities.length > 0;
  const supportsTools = hasCapabilitySignal ? capabilities.includes("tools") : true;
  return {
    id: modelId,
    name: modelId,
    reasoning: isReasoningModelHeuristic(modelId),
    input,
    cost: OLLAMA_DEFAULT_COST,
    contextWindow: contextWindow ?? OLLAMA_DEFAULT_CONTEXT_WINDOW,
    maxTokens: OLLAMA_DEFAULT_MAX_TOKENS,
    ...(hasCapabilitySignal && !supportsTools ? { compat: { supportsTools: false } } : {}),
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

export function resetOllamaModelShowInfoCacheForTest(): void {
  ollamaModelShowInfoCache.clear();
}
