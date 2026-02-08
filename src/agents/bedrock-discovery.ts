import {
  BedrockClient,
  ListInferenceProfilesCommand,
  type ListInferenceProfilesCommandOutput,
} from "@aws-sdk/client-bedrock";
import type { BedrockDiscoveryConfig, ModelDefinitionConfig } from "../config/types.js";

const DEFAULT_REFRESH_INTERVAL_SECONDS = 3600;
const DEFAULT_CONTEXT_WINDOW = 32000;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

type InferenceProfileSummary = NonNullable<
  ListInferenceProfilesCommandOutput["inferenceProfileSummaries"]
>[number];

type BedrockDiscoveryCacheEntry = {
  expiresAt: number;
  value?: ModelDefinitionConfig[];
  inFlight?: Promise<ModelDefinitionConfig[]>;
};

const discoveryCache = new Map<string, BedrockDiscoveryCacheEntry>();
let hasLoggedBedrockError = false;

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
  region: string;
  providerFilter: string[];
  refreshIntervalSeconds: number;
  defaultContextWindow: number;
  defaultMaxTokens: number;
}): string {
  return JSON.stringify(params);
}

function isActive(summary: InferenceProfileSummary): boolean {
  return summary.status === "ACTIVE";
}

function inferReasoningSupport(summary: InferenceProfileSummary): boolean {
  const haystack =
    `${summary.inferenceProfileId ?? ""} ${summary.inferenceProfileName ?? ""}`.toLowerCase();
  return haystack.includes("reasoning") || haystack.includes("thinking");
}

function extractProviderFromId(inferenceProfileId: string): string | undefined {
  // e.g. "us.anthropic.claude-3-5-sonnet-20241022-v2:0" -> "anthropic"
  const parts = inferenceProfileId.split(".");
  if (parts.length >= 2) {
    return parts[1].toLowerCase();
  }
  return undefined;
}

function matchesProviderFilter(summary: InferenceProfileSummary, filter: string[]): boolean {
  if (filter.length === 0) {
    return true;
  }
  const provider = extractProviderFromId(summary.inferenceProfileId ?? "");
  if (!provider) {
    return false;
  }
  return filter.includes(provider);
}

function shouldIncludeSummary(summary: InferenceProfileSummary, filter: string[]): boolean {
  if (!summary.inferenceProfileId?.trim()) {
    return false;
  }
  if (!matchesProviderFilter(summary, filter)) {
    return false;
  }
  if (!isActive(summary)) {
    return false;
  }
  return true;
}

function resolveDefaultContextWindow(config?: BedrockDiscoveryConfig): number {
  const value = Math.floor(config?.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW);
  return value > 0 ? value : DEFAULT_CONTEXT_WINDOW;
}

function resolveDefaultMaxTokens(config?: BedrockDiscoveryConfig): number {
  const value = Math.floor(config?.defaultMaxTokens ?? DEFAULT_MAX_TOKENS);
  return value > 0 ? value : DEFAULT_MAX_TOKENS;
}

function toModelDefinition(
  summary: InferenceProfileSummary,
  defaults: { contextWindow: number; maxTokens: number },
): ModelDefinitionConfig {
  const id = summary.inferenceProfileId?.trim() ?? "";
  return {
    id,
    name: summary.inferenceProfileName?.trim() || id,
    reasoning: inferReasoningSupport(summary),
    input: ["text"] as Array<"text" | "image">,
    cost: DEFAULT_COST,
    contextWindow: defaults.contextWindow,
    maxTokens: defaults.maxTokens,
  };
}

export function resetBedrockDiscoveryCacheForTest(): void {
  discoveryCache.clear();
  hasLoggedBedrockError = false;
}

export async function discoverBedrockModels(params: {
  region: string;
  config?: BedrockDiscoveryConfig;
  now?: () => number;
  clientFactory?: (region: string) => BedrockClient;
}): Promise<ModelDefinitionConfig[]> {
  const refreshIntervalSeconds = Math.max(
    0,
    Math.floor(params.config?.refreshInterval ?? DEFAULT_REFRESH_INTERVAL_SECONDS),
  );
  const providerFilter = normalizeProviderFilter(params.config?.providerFilter);
  const defaultContextWindow = resolveDefaultContextWindow(params.config);
  const defaultMaxTokens = resolveDefaultMaxTokens(params.config);
  const cacheKey = buildCacheKey({
    region: params.region,
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

  const clientFactory = params.clientFactory ?? ((region: string) => new BedrockClient({ region }));
  const client = clientFactory(params.region);

  const discoveryPromise = (async () => {
    const discovered: ModelDefinitionConfig[] = [];
    let nextToken: string | undefined;

    do {
      const response = await client.send(
        new ListInferenceProfilesCommand({
          maxResults: 1000,
          nextToken,
          typeEquals: "SYSTEM_DEFINED",
        }),
      );

      for (const summary of response.inferenceProfileSummaries ?? []) {
        if (!shouldIncludeSummary(summary, providerFilter)) {
          continue;
        }
        discovered.push(
          toModelDefinition(summary, {
            contextWindow: defaultContextWindow,
            maxTokens: defaultMaxTokens,
          }),
        );
      }

      nextToken = response.nextToken;
    } while (nextToken);

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
    if (!hasLoggedBedrockError) {
      hasLoggedBedrockError = true;
      console.warn(`[bedrock-discovery] Failed to list models: ${String(error)}`);
    }
    return [];
  }
}
