import {
  BedrockClient,
  ListFoundationModelsCommand,
  ListInferenceProfilesCommand,
  type ListFoundationModelsCommandOutput,
  type ListInferenceProfilesCommandOutput,
} from "@aws-sdk/client-bedrock";
import type { BedrockDiscoveryConfig, ModelDefinitionConfig } from "../config/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("bedrock-discovery");

const DEFAULT_REFRESH_INTERVAL_SECONDS = 3600;
const PARTIAL_FAILURE_CACHE_TTL_SECONDS = 60;
const DEFAULT_CONTEXT_WINDOW = 32000;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

type BedrockModelSummary = NonNullable<ListFoundationModelsCommandOutput["modelSummaries"]>[number];
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
const INFERENCE_PROFILE_PAGE_SIZE = 100;
const INFERENCE_PROFILE_LOCATION_PREFIXES = new Set([
  "us",
  "eu",
  "ap",
  "sa",
  "ca",
  "me",
  "af",
  "apac",
  "latam",
  "emea",
  "global",
]);
const INFERENCE_PROFILE_REGION_PREFIX_PATTERN = /^[a-z]{2}(?:-[a-z0-9-]+)?$/;

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

function includesTextModalities(modalities?: Array<string>): boolean {
  return (modalities ?? []).some((entry) => entry.toLowerCase() === "text");
}

function isActive(summary: BedrockModelSummary): boolean {
  const status = summary.modelLifecycle?.status;
  return typeof status === "string" ? status.toUpperCase() === "ACTIVE" : false;
}

function isInferenceProfileActive(summary: InferenceProfileSummary): boolean {
  const status = summary.status;
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

function inferReasoningSupport(id: string | undefined, name: string | undefined): boolean {
  const haystack = `${id ?? ""} ${name ?? ""}`.toLowerCase();
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

function matchesFoundationProviderFilter(summary: BedrockModelSummary, filter: string[]): boolean {
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

function isInferenceProfileLocationPrefix(part: string): boolean {
  if (INFERENCE_PROFILE_LOCATION_PREFIXES.has(part)) {
    return true;
  }
  return INFERENCE_PROFILE_REGION_PREFIX_PATTERN.test(part);
}

function extractInferenceProviderId(summary: InferenceProfileSummary): string | undefined {
  const rawId = summary.inferenceProfileId?.trim().toLowerCase();
  if (!rawId) {
    return undefined;
  }
  const idTail = rawId.includes("/") ? (rawId.split("/").pop() ?? rawId) : rawId;
  const parts = idTail.split(".").filter((part) => part.length > 0);
  if (parts.length === 0) {
    return undefined;
  }
  if (parts.length > 1 && isInferenceProfileLocationPrefix(parts[0])) {
    return parts[1];
  }
  return parts[0];
}

function matchesInferenceProviderFilter(
  summary: InferenceProfileSummary,
  filter: string[],
): boolean {
  if (filter.length === 0) {
    return true;
  }
  const providerId = extractInferenceProviderId(summary);
  if (!providerId) {
    return false;
  }
  return filter.includes(providerId);
}

function shouldIncludeFoundationModel(summary: BedrockModelSummary, filter: string[]): boolean {
  if (!summary.modelId?.trim()) {
    return false;
  }
  if (!matchesFoundationProviderFilter(summary, filter)) {
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

function shouldIncludeInferenceProfile(
  summary: InferenceProfileSummary,
  filter: string[],
): boolean {
  if (!summary.inferenceProfileId?.trim()) {
    return false;
  }
  if (!matchesInferenceProviderFilter(summary, filter)) {
    return false;
  }
  if (!isInferenceProfileActive(summary)) {
    return false;
  }
  return true;
}

function toModelDefinitionFromFoundationModel(
  summary: BedrockModelSummary,
  defaults: { contextWindow: number; maxTokens: number },
): ModelDefinitionConfig {
  const id = summary.modelId?.trim() ?? "";
  return {
    id,
    name: summary.modelName?.trim() || id,
    reasoning: inferReasoningSupport(summary.modelId, summary.modelName),
    input: mapInputModalities(summary),
    cost: DEFAULT_COST,
    contextWindow: defaults.contextWindow,
    maxTokens: defaults.maxTokens,
  };
}

function toModelDefinitionFromInferenceProfile(
  summary: InferenceProfileSummary,
  defaults: { contextWindow: number; maxTokens: number },
): ModelDefinitionConfig {
  const id = summary.inferenceProfileId?.trim() ?? "";
  return {
    id,
    name: summary.inferenceProfileName?.trim() || id,
    reasoning: inferReasoningSupport(summary.inferenceProfileId, summary.inferenceProfileName),
    // Inference profile summaries do not expose full modality metadata.
    input: ["text"],
    cost: DEFAULT_COST,
    contextWindow: defaults.contextWindow,
    maxTokens: defaults.maxTokens,
  };
}

async function listInferenceProfileSummaries(
  client: BedrockClient,
): Promise<InferenceProfileSummary[]> {
  const summaries: InferenceProfileSummary[] = [];
  let nextToken: string | undefined;
  do {
    const response = await client.send(
      new ListInferenceProfilesCommand({
        maxResults: INFERENCE_PROFILE_PAGE_SIZE,
        ...(nextToken ? { nextToken } : {}),
      }),
    );
    summaries.push(...(response.inferenceProfileSummaries ?? []));
    nextToken = response.nextToken;
  } while (nextToken);
  return summaries;
}

function dedupeModelsById(models: ModelDefinitionConfig[]): ModelDefinitionConfig[] {
  const byId = new Map<string, ModelDefinitionConfig>();
  for (const model of models) {
    if (!model.id || byId.has(model.id)) {
      continue;
    }
    byId.set(model.id, model);
  }
  return Array.from(byId.values());
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
  let hadPartialFailure = false;

  const discoveryPromise = (async () => {
    const defaults = {
      contextWindow: defaultContextWindow,
      maxTokens: defaultMaxTokens,
    };

    const discovered: ModelDefinitionConfig[] = [];
    const partialFailures: unknown[] = [];

    try {
      const response = await client.send(new ListFoundationModelsCommand({}));
      for (const summary of response.modelSummaries ?? []) {
        if (!shouldIncludeFoundationModel(summary, providerFilter)) {
          continue;
        }
        discovered.push(toModelDefinitionFromFoundationModel(summary, defaults));
      }
    } catch (error) {
      hadPartialFailure = true;
      log.warn(`Failed to list foundation models during Bedrock discovery: ${String(error)}`);
      partialFailures.push(error);
    }

    try {
      const inferenceProfiles = await listInferenceProfileSummaries(client);
      for (const summary of inferenceProfiles) {
        if (!shouldIncludeInferenceProfile(summary, providerFilter)) {
          continue;
        }
        discovered.push(toModelDefinitionFromInferenceProfile(summary, defaults));
      }
    } catch (error) {
      hadPartialFailure = true;
      log.warn(`Failed to list inference profiles during Bedrock discovery: ${String(error)}`);
      partialFailures.push(error);
    }

    if (discovered.length === 0 && partialFailures.length > 0) {
      throw partialFailures[0];
    }

    return dedupeModelsById(discovered).toSorted((a, b) => a.name.localeCompare(b.name));
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
      if (hadPartialFailure) {
        const partialTtlSeconds = Math.min(
          refreshIntervalSeconds,
          PARTIAL_FAILURE_CACHE_TTL_SECONDS,
        );
        if (partialTtlSeconds > 0) {
          discoveryCache.set(cacheKey, {
            expiresAt: now + partialTtlSeconds * 1000,
            value,
          });
        } else {
          discoveryCache.delete(cacheKey);
        }
      } else {
        discoveryCache.set(cacheKey, {
          expiresAt: now + refreshIntervalSeconds * 1000,
          value,
        });
      }
    }
    return value;
  } catch (error) {
    if (refreshIntervalSeconds > 0) {
      discoveryCache.delete(cacheKey);
    }
    if (!hasLoggedBedrockError) {
      hasLoggedBedrockError = true;
      log.warn(`Failed to list models: ${String(error)}`);
    }
    return [];
  }
}
