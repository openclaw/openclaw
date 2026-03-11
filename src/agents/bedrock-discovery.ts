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

function shouldIncludeInferenceProfile(
  summary: BedrockInferenceProfileSummary,
  foundationSummary: BedrockModelSummary | undefined,
  filter: string[],
): boolean {
  if (!summary.inferenceProfileId?.trim()) {
    return false;
  }
  if (summary.status !== "ACTIVE") {
    return false;
  }
  if (!foundationSummary) {
    return false;
  }
  return shouldIncludeSummary(foundationSummary, filter);
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

function extractModelIdFromArn(modelArn?: string): string | null {
  const trimmed = modelArn?.trim();
  if (!trimmed) {
    return null;
  }
  const foundationIndex = trimmed.indexOf(":foundation-model/");
  if (foundationIndex >= 0) {
    return trimmed.slice(foundationIndex + ":foundation-model/".length).trim() || null;
  }
  const promptRouterIndex = trimmed.indexOf(":inference-profile/");
  if (promptRouterIndex >= 0) {
    return trimmed.slice(promptRouterIndex + ":inference-profile/".length).trim() || null;
  }
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1).trim() || null : trimmed;
}

async function listInferenceProfiles(
  client: BedrockClient,
): Promise<BedrockInferenceProfileSummary[]> {
  const summaries: BedrockInferenceProfileSummary[] = [];
  let nextToken: string | undefined;
  do {
    const response = await client.send(
      new ListInferenceProfilesCommand(nextToken ? { nextToken } : {}),
    );
    summaries.push(...(response.inferenceProfileSummaries ?? []));
    nextToken = response.nextToken;
  } while (nextToken);
  return summaries;
}

function toInferenceProfileDefinition(params: {
  profile: BedrockInferenceProfileSummary;
  foundationSummary: BedrockModelSummary;
  defaults: { contextWindow: number; maxTokens: number };
}): ModelDefinitionConfig {
  const id = params.profile.inferenceProfileId?.trim() ?? "";
  return {
    id,
    name: params.profile.inferenceProfileName?.trim() || id,
    reasoning: inferReasoningSupport(params.foundationSummary),
    input: mapInputModalities(params.foundationSummary),
    cost: DEFAULT_COST,
    contextWindow: params.defaults.contextWindow,
    maxTokens: params.defaults.maxTokens,
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
    const [foundationResponse, inferenceProfiles] = await Promise.all([
      client.send(new ListFoundationModelsCommand({})),
      listInferenceProfiles(client),
    ]);
    const foundationSummaries = (foundationResponse.modelSummaries ?? []).filter((summary) =>
      shouldIncludeSummary(summary, providerFilter),
    );
    const foundationById = new Map(
      foundationSummaries
        .map((summary) => [summary.modelId?.trim() ?? "", summary] as const)
        .filter(([id]) => id.length > 0),
    );
    const discovered: ModelDefinitionConfig[] = [];
    const coveredFoundationIds = new Set<string>();

    for (const profile of inferenceProfiles) {
      const foundationSummary = profile.models
        ?.map((entry) => foundationById.get(extractModelIdFromArn(entry.modelArn) ?? ""))
        .find((summary): summary is BedrockModelSummary => Boolean(summary));
      if (
        !shouldIncludeInferenceProfile(profile, foundationSummary, providerFilter) ||
        !foundationSummary
      ) {
        continue;
      }
      const foundationId = foundationSummary.modelId?.trim();
      if (foundationId) {
        coveredFoundationIds.add(foundationId);
      }
      discovered.push(
        toInferenceProfileDefinition({
          profile,
          foundationSummary,
          defaults: {
            contextWindow: defaultContextWindow,
            maxTokens: defaultMaxTokens,
          },
        }),
      );
    }

    for (const summary of foundationSummaries) {
      const foundationId = summary.modelId?.trim();
      if (foundationId && coveredFoundationIds.has(foundationId)) {
        continue;
      }
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
      log.warn(`Failed to list models: ${String(error)}`);
    }
    return [];
  }
}
