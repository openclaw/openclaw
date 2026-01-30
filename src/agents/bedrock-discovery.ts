import {
  BedrockClient,
  ListFoundationModelsCommand,
  ListInferenceProfilesCommand,
  type ListFoundationModelsCommandOutput,
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

type BedrockDiscoveryCacheEntry = {
  expiresAt: number;
  value?: ModelDefinitionConfig[];
  inFlight?: Promise<ModelDefinitionConfig[]>;
};

const discoveryCache = new Map<string, BedrockDiscoveryCacheEntry>();
let hasLoggedBedrockError = false;
let hasLoggedInferenceProfileError = false;

function normalizeProviderFilter(filter?: string[]): string[] {
  if (!filter || filter.length === 0) return [];
  const normalized = new Set(
    filter.map((entry) => entry.trim().toLowerCase()).filter((entry) => entry.length > 0),
  );
  return Array.from(normalized).sort();
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
    if (lower === "text") mapped.add("text");
    if (lower === "image") mapped.add("image");
  }
  if (mapped.size === 0) mapped.add("text");
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
  if (filter.length === 0) return true;
  const providerName =
    summary.providerName ??
    (typeof summary.modelId === "string" ? summary.modelId.split(".")[0] : undefined);
  const normalized = providerName?.trim().toLowerCase();
  if (!normalized) return false;
  return filter.includes(normalized);
}

function shouldIncludeSummary(summary: BedrockModelSummary, filter: string[]): boolean {
  if (!summary.modelId?.trim()) return false;
  if (!matchesProviderFilter(summary, filter)) return false;
  if (summary.responseStreamingSupported !== true) return false;
  if (!includesTextModalities(summary.outputModalities)) return false;
  if (!isActive(summary)) return false;
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

export function resetBedrockDiscoveryCacheForTest(): void {
  discoveryCache.clear();
  hasLoggedBedrockError = false;
  hasLoggedInferenceProfileError = false;
}

async function discoverInferenceProfiles(params: {
  client: BedrockClient;
  baseModelsMap: Map<string, ModelDefinitionConfig>;
  providerFilter: string[];
}): Promise<ModelDefinitionConfig[]> {
  try {
    const response = await params.client.send(new ListInferenceProfilesCommand({}));
    const profiles: ModelDefinitionConfig[] = [];

    for (const profile of response.inferenceProfileSummaries ?? []) {
      const profileId = profile.inferenceProfileId?.trim();
      if (!profileId) continue;

      const status = profile.status?.toUpperCase();
      if (status !== "ACTIVE") continue;

      const baseModelId = (() => {
        const modelRef = profile.models?.[0];
        if (!modelRef) return undefined;
        return (modelRef as { modelArn?: string }).modelArn?.split("/")?.[1]?.trim();
      })();
      if (!baseModelId) continue;

      const baseModel = params.baseModelsMap.get(baseModelId);
      if (!baseModel) continue;

      if (params.providerFilter.length > 0) {
        const providerName = baseModelId.split(".")[0]?.trim().toLowerCase();
        if (!providerName || !params.providerFilter.includes(providerName)) {
          continue;
        }
      }

      const profileName = profile.inferenceProfileName?.trim() || profileId;

      profiles.push({
        id: profileId,
        name: profileName,
        reasoning: baseModel.reasoning,
        input: baseModel.input,
        cost: baseModel.cost,
        contextWindow: baseModel.contextWindow,
        maxTokens: baseModel.maxTokens,
      });
    }

    return profiles.sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    if (!hasLoggedInferenceProfileError) {
      hasLoggedInferenceProfileError = true;
      console.warn(`[bedrock-discovery] Failed to list inference profiles: ${String(error)}`);
    }
    return [];
  }
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
  const includeInferenceProfiles = params.config?.includeInferenceProfiles !== false;
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
    const response = await client.send(new ListFoundationModelsCommand({}));
    const baseModels: ModelDefinitionConfig[] = [];
    for (const summary of response.modelSummaries ?? []) {
      if (!shouldIncludeSummary(summary, providerFilter)) continue;
      baseModels.push(
        toModelDefinition(summary, {
          contextWindow: defaultContextWindow,
          maxTokens: defaultMaxTokens,
        }),
      );
    }

    const baseModelsMap = new Map(baseModels.map((model) => [model.id, model]));

    const profiles = includeInferenceProfiles
      ? await discoverInferenceProfiles({
          client,
          baseModelsMap,
          providerFilter,
        })
      : [];

    const combined = [...baseModels, ...profiles];
    return combined.sort((a, b) => a.name.localeCompare(b.name));
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
