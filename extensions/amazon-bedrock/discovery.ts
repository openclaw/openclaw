import {
  BedrockClient,
  ListFoundationModelsCommand,
  type ListFoundationModelsCommandOutput,
} from "@aws-sdk/client-bedrock";
import { createSubsystemLogger } from "openclaw/plugin-sdk/core";
import { resolveAwsSdkEnvVarName } from "openclaw/plugin-sdk/provider-auth-runtime";
import type {
  BedrockDiscoveryConfig,
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";

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
}

export function resolveBedrockConfigApiKey(env: NodeJS.ProcessEnv = process.env): string {
  return resolveAwsSdkEnvVarName(env) ?? "AWS_PROFILE";
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
    const response = await client.send(new ListFoundationModelsCommand({}));
    const discovered: ModelDefinitionConfig[] = [];
    for (const summary of response.modelSummaries ?? []) {
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
      log.warn("Failed to discover Bedrock models", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return [];
  }
}

export async function resolveImplicitBedrockProvider(params: {
  config?: { models?: { bedrockDiscovery?: BedrockDiscoveryConfig } };
  env?: NodeJS.ProcessEnv;
  bearerToken?: string;
  region?: string;
}): Promise<ModelProviderConfig | null> {
  const baseEnv = params.env ?? process.env;
  const discoveryConfig = params.config?.models?.bedrockDiscovery;
  const enabled = discoveryConfig?.enabled;

  // Sync process.env["AWS_BEARER_TOKEN_BEDROCK"] with the plugin-configured bearer token
  // so the AWS SDK client (which reads process.env directly) picks up the correct value.
  // - Set/overwrite when a token is provided and differs from the current env value,
  //   so that rotated tokens take effect without a process restart.
  // - Clear when no token is configured, so that removing the plugin config actually
  //   stops bearer-token auth rather than leaving a stale value in process.env.
  let env = baseEnv;
  const currentEnvToken = baseEnv["AWS_BEARER_TOKEN_BEDROCK"]?.trim();
  if (params.bearerToken) {
    if (params.bearerToken !== currentEnvToken) {
      process.env["AWS_BEARER_TOKEN_BEDROCK"] = params.bearerToken;
      if (baseEnv !== process.env) {
        env = { ...baseEnv, AWS_BEARER_TOKEN_BEDROCK: params.bearerToken };
      }
    }
  } else if (currentEnvToken && baseEnv === process.env) {
    // Token was removed from plugin config — clear the stale env var so the
    // AWS SDK does not continue authenticating with it.
    delete process.env["AWS_BEARER_TOKEN_BEDROCK"];
    env = { ...baseEnv };
    delete (env as Record<string, string | undefined>)["AWS_BEARER_TOKEN_BEDROCK"];
  }

  const hasAwsCreds = resolveAwsSdkEnvVarName(env) !== undefined;
  if (enabled === false) {
    return null;
  }
  if (enabled !== true && !hasAwsCreds) {
    return null;
  }

  const region =
    params.region?.trim() ||
    (discoveryConfig?.region ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "us-east-1");
  const models = await discoverBedrockModels({
    region,
    config: discoveryConfig,
  });
  if (models.length === 0) {
    return null;
  }

  return {
    baseUrl: `https://bedrock-runtime.${region}.amazonaws.com`,
    api: "bedrock-converse-stream",
    auth: "aws-sdk",
    models,
  };
}

export function mergeImplicitBedrockProvider(params: {
  existing: ModelProviderConfig | undefined;
  implicit: ModelProviderConfig;
}): ModelProviderConfig {
  const { existing, implicit } = params;
  if (!existing) {
    return implicit;
  }
  return {
    ...implicit,
    ...existing,
    models:
      Array.isArray(existing.models) && existing.models.length > 0
        ? existing.models
        : implicit.models,
  };
}
