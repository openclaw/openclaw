import {
  BedrockClient,
  ListFoundationModelsCommand,
  ListInferenceProfilesCommand,
  type ListFoundationModelsCommandOutput,
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

type BedrockModelSummary = NonNullable<ListFoundationModelsCommandOutput["modelSummaries"]>[number];
type BedrockInferenceProfileSummary = NonNullable<
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
  includeInferenceProfiles: boolean;
}): string {
  return JSON.stringify(params);
}

function includesTextModalities(modalities?: Array<string>): boolean {
  return (modalities ?? []).some((entry) => entry.toLowerCase() === "text");
}

function isActive(summary: BedrockModelSummary): boolean {
  const status = summary.modelLifecycle?.status;
  return typeof status === "string" ? status.toUpperCase() === "ACTIVE" : false;
}

function mapInputModalities(summary: BedrockModelSummary): Array<"text" | "image"> {
  const inputs = summary.inputModalities ?? [];
  const mapped = new Set<"text" | "image">();
  for (const modality of inputs) {
    const lower = modality.toLowerCase();
    if (lower === "text") {
      mapped.add("text");
    }
    if (lower === "image") {
      mapped.add("image");
    }
  }
  if (mapped.size === 0) {
    mapped.add("text");
  }
  return Array.from(mapped);
}

function inferReasoningSupport(summary: BedrockModelSummary): boolean {
  const haystack = `${summary.modelId ?? ""} ${summary.modelName ?? ""}`.toLowerCase();
  return haystack.includes("reasoning") || haystack.includes("thinking");
}

function resolveDefaultContextWindow(config?: BedrockDiscoveryConfig): number {
  const value = Math.floor(config?.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW);
  return value > 0 ? value : DEFAULT_CONTEXT_WINDOW;
}

function resolveDefaultMaxTokens(config?: BedrockDiscoveryConfig): number {
  const value = Math.floor(config?.defaultMaxTokens ?? DEFAULT_MAX_TOKENS);
  return value > 0 ? value : DEFAULT_MAX_TOKENS;
}

function matchesProviderFilter(summary: BedrockModelSummary, filter: string[]): boolean {
  if (filter.length === 0) {
    return true;
  }
  const providerName =
    summary.providerName ??
    (typeof summary.modelId === "string" ? summary.modelId.split(".")[0] : undefined);
  const normalized = providerName?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return filter.includes(normalized);
}

function shouldIncludeSummary(summary: BedrockModelSummary, filter: string[]): boolean {
  if (!summary.modelId?.trim()) {
    return false;
  }
  if (!matchesProviderFilter(summary, filter)) {
    return false;
  }
  if (summary.responseStreamingSupported !== true) {
    return false;
  }
  if (!includesTextModalities(summary.outputModalities)) {
    return false;
  }
  if (!isActive(summary)) {
    return false;
  }
  return true;
}

function toModelDefinition(
  summary: BedrockModelSummary,
  defaults: { contextWindow: number; maxTokens: number },
): ModelDefinitionConfig {
  const id = summary.modelId?.trim() ?? "";
  return {
    id,
    name: summary.modelName?.trim() || id,
    reasoning: inferReasoningSupport(summary),
    input: mapInputModalities(summary),
    cost: DEFAULT_COST,
    contextWindow: defaults.contextWindow,
    maxTokens: defaults.maxTokens,
  };
}

function inferenceProfileToModelDefinition(
  profile: BedrockInferenceProfileSummary,
  foundationModels: Map<string, BedrockModelSummary>,
  defaults: { contextWindow: number; maxTokens: number },
): ModelDefinitionConfig | null {
  const id = profile.inferenceProfileId?.trim();
  if (!id) {
    return null;
  }

  // Get the underlying foundation model to validate capabilities
  const modelArn = profile.models?.[0]?.modelArn;
  const modelId = modelArn?.split("/").pop();
  const foundationModel = modelId ? foundationModels.get(modelId) : undefined;

  // If we can't find the foundation model, skip this profile
  if (!foundationModel) {
    return null;
  }

  // Apply the same validation as foundation models
  if (!foundationModel.responseStreamingSupported) {
    return null;
  }

  if (!includesTextModalities(foundationModel.outputModalities)) {
    return null;
  }

  const name = profile.inferenceProfileName?.trim() || id;

  // Check if the profile ID or name suggests reasoning support
  const haystack = `${id} ${name}`.toLowerCase();
  const reasoning = haystack.includes("reasoning") || haystack.includes("thinking");

  return {
    id,
    name,
    reasoning,
    input: mapInputModalities(foundationModel),
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
  const includeInferenceProfiles = params.config?.includeInferenceProfiles ?? true;
  const cacheKey = buildCacheKey({
    region: params.region,
    providerFilter,
    refreshIntervalSeconds,
    defaultContextWindow,
    defaultMaxTokens,
    includeInferenceProfiles,
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

    // Discover foundation models
    const modelsResponse = await client.send(new ListFoundationModelsCommand({}));
    const foundationModelsMap = new Map<string, BedrockModelSummary>();

    for (const summary of modelsResponse.modelSummaries ?? []) {
      // Build map for inference profile validation
      if (summary.modelId) {
        foundationModelsMap.set(summary.modelId, summary);
      }
    }

    // Track which foundation models have inference profiles
    const modelsWithProfiles = new Set<string>();

    // Discover inference profiles (cross-region)
    if (includeInferenceProfiles) {
      try {
        const profilesResponse = await client.send(new ListInferenceProfilesCommand({}));
        for (const profile of profilesResponse.inferenceProfileSummaries ?? []) {
          if (profile.status !== "ACTIVE") {
            continue;
          }

          // Track the underlying foundation model
          const modelArn = profile.models?.[0]?.modelArn;
          const modelId = modelArn?.split("/").pop();
          if (modelId) {
            modelsWithProfiles.add(modelId);
          }

          const modelDef = inferenceProfileToModelDefinition(profile, foundationModelsMap, {
            contextWindow: defaultContextWindow,
            maxTokens: defaultMaxTokens,
          });
          if (modelDef) {
            if (providerFilter.length === 0) {
              discovered.push(modelDef);
            } else {
              const profileId = modelDef.id.toLowerCase();
              if (providerFilter.some((filter) => profileId.includes(filter))) {
                discovered.push(modelDef);
              }
            }
          }
        }
      } catch (error) {
        if (!hasLoggedBedrockError) {
          hasLoggedBedrockError = true;
          console.warn(`[bedrock-discovery] Failed to list inference profiles: ${String(error)}`);
        }
      }
    }

    // Add foundation models that don't have inference profiles
    for (const summary of modelsResponse.modelSummaries ?? []) {
      if (!shouldIncludeSummary(summary, providerFilter)) {
        continue;
      }

      // Skip foundation models that have inference profiles
      if (includeInferenceProfiles && modelsWithProfiles.has(summary.modelId ?? "")) {
        continue;
      }

      discovered.push(
        toModelDefinition(summary, {
          contextWindow: defaultContextWindow,
          maxTokens: defaultMaxTokens,
        }),
      );
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
    if (!hasLoggedBedrockError) {
      hasLoggedBedrockError = true;
      console.warn(`[bedrock-discovery] Failed to list models: ${String(error)}`);
    }
    return [];
  }
}
