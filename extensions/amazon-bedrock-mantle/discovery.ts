import { createSubsystemLogger } from "openclaw/plugin-sdk/core";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";

const log = createSubsystemLogger("bedrock-mantle-discovery");

const DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

const DEFAULT_CONTEXT_WINDOW = 32000;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_REFRESH_INTERVAL_SECONDS = 3600; // 1 hour

// ---------------------------------------------------------------------------
// Mantle region & endpoint helpers
// ---------------------------------------------------------------------------

const MANTLE_SUPPORTED_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-2",
  "ap-northeast-1",
  "ap-south-1",
  "ap-southeast-3",
  "eu-central-1",
  "eu-west-1",
  "eu-west-2",
  "eu-south-1",
  "eu-north-1",
  "sa-east-1",
] as const;

function mantleEndpoint(region: string): string {
  return `https://bedrock-mantle.${region}.api.aws`;
}

function isSupportedRegion(region: string): boolean {
  return (MANTLE_SUPPORTED_REGIONS as readonly string[]).includes(region);
}

// ---------------------------------------------------------------------------
// Bearer token resolution
// ---------------------------------------------------------------------------

export type MantleBearerTokenProvider = () => Promise<string>;

/**
 * Resolve a bearer token for Mantle authentication.
 *
 * Returns the value of AWS_BEARER_TOKEN_BEDROCK if set, undefined otherwise.
 *
 * Mantle's OpenAI-compatible surface expects a bearer token today in OpenClaw.
 * Plain IAM credentials (instance roles, SSO, access keys) are not enough
 * until we wire in SigV4-derived token generation via `@aws/bedrock-token-generator`.
 */
export function resolveMantleBearerToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicitToken = env.AWS_BEARER_TOKEN_BEDROCK?.trim();
  if (explicitToken) {
    return explicitToken;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// OpenAI-format model list response
// ---------------------------------------------------------------------------

interface OpenAIModelEntry {
  id: string;
  object?: string;
  owned_by?: string;
  created?: number;
}

interface OpenAIModelsResponse {
  data?: OpenAIModelEntry[];
  object?: string;
}

// ---------------------------------------------------------------------------
// Reasoning heuristic
// ---------------------------------------------------------------------------

/** Model ID substrings that indicate reasoning/thinking support. */
const REASONING_PATTERNS = [
  "thinking",
  "reasoner",
  "reasoning",
  "deepseek.r",
  "gpt-oss-120b", // GPT-OSS 120B supports reasoning
  "gpt-oss-safeguard-120b",
];

function inferReasoningSupport(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return REASONING_PATTERNS.some((p) => lower.includes(p));
}

// ---------------------------------------------------------------------------
// Discovery cache
// ---------------------------------------------------------------------------

interface MantleCacheEntry {
  models: ModelDefinitionConfig[];
  fetchedAt: number;
}

const discoveryCache = new Map<string, MantleCacheEntry>();

/** Clear the discovery cache (for testing). */
export function resetMantleDiscoveryCacheForTest(): void {
  discoveryCache.clear();
}

// ---------------------------------------------------------------------------
// Model discovery
// ---------------------------------------------------------------------------

/**
 * Discover available models from the Mantle `/v1/models` endpoint.
 *
 * The response is in standard OpenAI format:
 * ```json
 * { "data": [{ "id": "anthropic.claude-sonnet-4-6", "object": "model", "owned_by": "anthropic" }] }
 * ```
 *
 * Results are cached per region for `DEFAULT_REFRESH_INTERVAL_SECONDS`.
 * Returns an empty array if the request fails (no permission, network error, etc.).
 */
export async function discoverMantleModels(params: {
  region: string;
  bearerToken: string;
  fetchFn?: typeof fetch;
  now?: () => number;
}): Promise<ModelDefinitionConfig[]> {
  const { region, bearerToken, fetchFn = fetch, now = Date.now } = params;

  // Check cache
  const cacheKey = region;
  const cached = discoveryCache.get(cacheKey);
  if (cached && now() - cached.fetchedAt < DEFAULT_REFRESH_INTERVAL_SECONDS * 1000) {
    return cached.models;
  }

  const endpoint = `${mantleEndpoint(region)}/v1/models`;

  try {
    const response = await fetchFn(endpoint, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      log.debug?.("Mantle model discovery failed", {
        status: response.status,
        statusText: response.statusText,
      });
      return cached?.models ?? [];
    }

    const body = (await response.json()) as OpenAIModelsResponse;
    const rawModels = body.data ?? [];

    const models = rawModels
      .filter((m) => m.id?.trim())
      .map((m) => ({
        id: m.id,
        name: m.id, // Mantle doesn't return display names
        reasoning: inferReasoningSupport(m.id),
        input: ["text" as const],
        cost: DEFAULT_COST,
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        maxTokens: DEFAULT_MAX_TOKENS,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));

    discoveryCache.set(cacheKey, { models, fetchedAt: now() });
    return models;
  } catch (error) {
    log.debug?.("Mantle model discovery error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return cached?.models ?? [];
  }
}

// ---------------------------------------------------------------------------
// Implicit provider resolution
// ---------------------------------------------------------------------------

/**
 * Resolve an implicit Bedrock Mantle provider if bearer-token auth is available.
 *
 * Detection:
 * - AWS_BEARER_TOKEN_BEDROCK is set → Mantle is available
 * - Region from AWS_REGION / AWS_DEFAULT_REGION / default us-east-1
 * - Models discovered from `/v1/models`
 */
export async function resolveImplicitMantleProvider(params: {
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
}): Promise<ModelProviderConfig | null> {
  const env = params.env ?? process.env;
  const bearerToken = resolveMantleBearerToken(env);

  if (!bearerToken) {
    return null;
  }

  const region = env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "us-east-1";

  if (!isSupportedRegion(region)) {
    log.debug?.("Mantle not available in region", { region });
    return null;
  }

  const models = await discoverMantleModels({
    region,
    bearerToken,
    fetchFn: params.fetchFn,
  });

  if (models.length === 0) {
    return null;
  }

  return {
    baseUrl: `${mantleEndpoint(region)}/v1`,
    api: "openai-completions",
    auth: "api-key",
    apiKey: "env:AWS_BEARER_TOKEN_BEDROCK",
    models,
  };
}

export function mergeImplicitMantleProvider(params: {
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
