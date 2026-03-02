import type { ModelDefinitionConfig } from "../config/types.models.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { AZURE_FOUNDRY_ANTHROPIC_API_VERSION, isAnthropicModelId } from "./azure-foundry-models.js";

const log = createSubsystemLogger("azure-foundry-discovery");

const DEFAULT_REFRESH_INTERVAL_SECONDS = 3600;
const DEFAULT_CONTEXT_WINDOW = 32000;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export type AzureFoundryDiscoveryConfig = {
  enabled?: boolean;
  endpoint?: string;
  providerFilter?: string[];
  refreshInterval?: number;
  defaultContextWindow?: number;
  defaultMaxTokens?: number;
};

type AzureFoundryModelEntry = {
  id?: string;
  name?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
};

type AzureFoundryDiscoveryCacheEntry = {
  expiresAt: number;
  value?: ModelDefinitionConfig[];
  inFlight?: Promise<ModelDefinitionConfig[]>;
};

const discoveryCache = new Map<string, AzureFoundryDiscoveryCacheEntry>();
let hasLoggedAzureFoundryError = false;

function normalizeProviderFilter(filter?: string[]): string[] {
  if (!filter || filter.length === 0) {
    return [];
  }
  const normalized = new Set(
    filter.map((entry) => entry.trim().toLowerCase()).filter((entry) => entry.length > 0),
  );
  return Array.from(normalized).toSorted();
}

function buildCacheKey(params: {
  endpoint: string;
  providerFilter: string[];
  refreshIntervalSeconds: number;
  defaultContextWindow: number;
  defaultMaxTokens: number;
}): string {
  return JSON.stringify(params);
}

function matchesProviderFilter(modelId: string, filter: string[]): boolean {
  if (filter.length === 0) {
    return true;
  }
  const normalized = modelId.trim().toLowerCase();
  return filter.some((f) => normalized.includes(f));
}

function inferReasoningSupport(modelId: string, modelName: string): boolean {
  const haystack = `${modelId} ${modelName}`.toLowerCase();
  return (
    haystack.includes("reasoning") || haystack.includes("thinking") || /\bo[34]-/.test(haystack)
  );
}

function inferInputModalities(modelId: string, modelName: string): Array<"text" | "image"> {
  const haystack = `${modelId} ${modelName}`.toLowerCase();
  if (
    haystack.includes("gpt-4o") ||
    haystack.includes("gpt-4.1") ||
    haystack.includes("vision") ||
    haystack.includes("claude")
  ) {
    return ["text", "image"];
  }
  return ["text"];
}

function resolveDefaultContextWindow(config?: AzureFoundryDiscoveryConfig): number {
  const value = Math.floor(config?.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW);
  return value > 0 ? value : DEFAULT_CONTEXT_WINDOW;
}

function resolveDefaultMaxTokens(config?: AzureFoundryDiscoveryConfig): number {
  const value = Math.floor(config?.defaultMaxTokens ?? DEFAULT_MAX_TOKENS);
  return value > 0 ? value : DEFAULT_MAX_TOKENS;
}

function toModelDefinition(
  entry: AzureFoundryModelEntry,
  defaults: { contextWindow: number; maxTokens: number; endpoint: string },
): ModelDefinitionConfig | null {
  const id = entry.id?.trim();
  if (!id) {
    return null;
  }
  const name = entry.name?.trim() || id;
  const base: ModelDefinitionConfig = {
    id,
    name,
    reasoning: inferReasoningSupport(id, name),
    input: inferInputModalities(id, name),
    cost: DEFAULT_COST,
    contextWindow: defaults.contextWindow,
    maxTokens: defaults.maxTokens,
  };
  // Route Anthropic (Claude) models to the /anthropic endpoint
  if (isAnthropicModelId(id)) {
    base.api = "anthropic-messages";
    base.baseUrl = `${defaults.endpoint}/anthropic`;
    base.headers = { "api-version": AZURE_FOUNDRY_ANTHROPIC_API_VERSION };
  }
  return base;
}

export function resetAzureFoundryDiscoveryCacheForTest(): void {
  discoveryCache.clear();
  hasLoggedAzureFoundryError = false;
}

export async function discoverAzureFoundryModels(params: {
  endpoint: string;
  apiKey: string;
  config?: AzureFoundryDiscoveryConfig;
  now?: () => number;
  fetchFn?: typeof fetch;
}): Promise<ModelDefinitionConfig[]> {
  const refreshIntervalSeconds = Math.max(
    0,
    Math.floor(params.config?.refreshInterval ?? DEFAULT_REFRESH_INTERVAL_SECONDS),
  );
  const providerFilter = normalizeProviderFilter(params.config?.providerFilter);
  const defaultContextWindow = resolveDefaultContextWindow(params.config);
  const defaultMaxTokens = resolveDefaultMaxTokens(params.config);
  const cacheKey = buildCacheKey({
    endpoint: params.endpoint,
    providerFilter,
    refreshIntervalSeconds,
    defaultContextWindow,
    defaultMaxTokens,
  });
  const now = params.now?.() ?? Date.now();

  if (refreshIntervalSeconds > 0) {
    const cached = discoveryCache.get(cacheKey);
    if (cached?.value && cached.expiresAt > now) {
      return cached.value;
    }
    if (cached?.inFlight) {
      return cached.inFlight;
    }
  }

  const fetchFn = params.fetchFn ?? fetch;
  const endpoint = params.endpoint.replace(/\/+$/, "");
  const url = `${endpoint}/models?api-version=2024-05-01-preview`;

  const discoveryPromise = (async () => {
    const response = await fetchFn(url, {
      method: "GET",
      headers: {
        "api-key": params.apiKey,
        Accept: "application/json",
      },
    });
    if (!response.ok) {
      throw new Error(`Azure Foundry model listing failed (${response.status})`);
    }
    const body = (await response.json()) as { data?: AzureFoundryModelEntry[] };
    const entries = body.data ?? [];
    const discovered: ModelDefinitionConfig[] = [];
    for (const entry of entries) {
      if (!matchesProviderFilter(entry.id ?? "", providerFilter)) {
        continue;
      }
      const def = toModelDefinition(entry, {
        contextWindow: defaultContextWindow,
        maxTokens: defaultMaxTokens,
        endpoint,
      });
      if (def) {
        discovered.push(def);
      }
    }
    return discovered.toSorted((a, b) => a.name.localeCompare(b.name));
  })();

  if (refreshIntervalSeconds > 0) {
    discoveryCache.set(cacheKey, {
      expiresAt: now + refreshIntervalSeconds * 1000,
      inFlight: discoveryPromise,
    });
  }

  try {
    const value = await discoveryPromise;
    if (refreshIntervalSeconds > 0) {
      discoveryCache.set(cacheKey, {
        expiresAt: now + refreshIntervalSeconds * 1000,
        value,
      });
    }
    return value;
  } catch (error) {
    if (refreshIntervalSeconds > 0) {
      discoveryCache.delete(cacheKey);
    }
    if (!hasLoggedAzureFoundryError) {
      hasLoggedAzureFoundryError = true;
      log.warn(`Failed to list Azure Foundry models: ${String(error)}`);
    }
    return [];
  }
}
