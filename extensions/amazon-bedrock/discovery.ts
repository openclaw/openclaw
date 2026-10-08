import type { BedrockClient, ListInferenceProfilesCommandOutput } from "@aws-sdk/client-bedrock";
import {
  isFutureDateTimestampMs,
  resolveExpiresAtMsFromDurationSeconds,
} from "openclaw/plugin-sdk/number-runtime";
import { resolveAwsSdkEnvVarName } from "openclaw/plugin-sdk/provider-auth-runtime";
import { LiveModelCatalogHttpError } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type {
  BedrockDiscoveryConfig,
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  resolveClaudeModelIdentity,
  supportsClaudeAdaptiveThinking,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  asOptionalRecord,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  normalizeSortedUniqueTrimmedStringList,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  loadBedrockControlPlaneSdk,
  runBedrockControlPlaneRequest,
  type BedrockControlPlaneSdk,
} from "./control-plane.js";
import { isClaude5BedrockModel, resolveBedrockNativeThinkingLevelMap } from "./thinking-policy.js";

const DEFAULT_REFRESH_INTERVAL_SECONDS = 3600;
const DEFAULT_CONTEXT_WINDOW = 32_000;
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Bedrock's ListFoundationModels and GetFoundationModel APIs return no token
 * limit information — only model ID, name, modalities, and lifecycle status.
 * There is currently no Bedrock API to discover context windows or max output
 * tokens programmatically.
 *
 * This map provides correct context window values for known models so that
 * session management, compaction thresholds, and context overflow detection
 * work correctly. If AWS adds token metadata to the API in the future, this
 * table should become a fallback rather than the primary source.
 *
 * Inference profile prefixes (us., eu., ap., global.) are stripped before lookup.
 *
 * Sources: https://docs.aws.amazon.com/bedrock/latest/userguide/models-supported.html
 *          https://platform.claude.com/docs/en/about-claude/models
 */
const KNOWN_CONTEXT_WINDOWS: Record<string, number> = {
  // Anthropic Claude
  "anthropic.claude-3-7-sonnet-20250219-v1:0": 200_000,
  "anthropic.claude-opus-4-7": 1_000_000,
  "anthropic.claude-opus-4-6-v1": 1_000_000,
  "anthropic.claude-sonnet-4-6": 1_000_000,
  "anthropic.claude-sonnet-4-5-20250929-v1:0": 200_000,
  "anthropic.claude-sonnet-4-20250514-v1:0": 200_000,
  "anthropic.claude-opus-4-5-20251101-v1:0": 200_000,
  "anthropic.claude-opus-4-1-20250805-v1:0": 200_000,
  "anthropic.claude-haiku-4-5-20251001-v1:0": 200_000,
  "anthropic.claude-3-5-haiku-20241022-v1:0": 200_000,
  "anthropic.claude-3-haiku-20240307-v1:0": 200_000,
  // Amazon Nova
  "amazon.nova-premier-v1:0": 1_000_000,
  "amazon.nova-pro-v1:0": 300_000,
  "amazon.nova-lite-v1:0": 300_000,
  "amazon.nova-micro-v1:0": 128_000,
  "amazon.nova-2-lite-v1:0": 300_000,
  // MiniMax
  "minimax.minimax-m2.5": 1_000_000,
  "minimax.minimax-m2.1": 1_000_000,
  "minimax.minimax-m2": 1_000_000,
  // Meta Llama 4
  "meta.llama4-maverick-17b-instruct-v1:0": 1_000_000,
  "meta.llama4-scout-17b-instruct-v1:0": 512_000,
  // Meta Llama 3
  "meta.llama3-3-70b-instruct-v1:0": 128_000,
  "meta.llama3-2-90b-instruct-v1:0": 128_000,
  "meta.llama3-2-11b-instruct-v1:0": 128_000,
  "meta.llama3-2-3b-instruct-v1:0": 128_000,
  "meta.llama3-2-1b-instruct-v1:0": 128_000,
  "meta.llama3-1-405b-instruct-v1:0": 128_000,
  "meta.llama3-1-70b-instruct-v1:0": 128_000,
  "meta.llama3-1-8b-instruct-v1:0": 128_000,
  // NVIDIA Nemotron
  "nvidia.nemotron-super-3-120b": 256_000,
  "nvidia.nemotron-nano-3-30b": 128_000,
  "nvidia.nemotron-nano-12b-v2": 128_000,
  "nvidia.nemotron-nano-9b-v2": 128_000,
  // Mistral
  "mistral.mistral-large-3-675b-instruct": 128_000,
  "mistral.mistral-large-2407-v1:0": 128_000,
  "mistral.mistral-small-2402-v1:0": 32_000,
  // DeepSeek
  "deepseek.r1-v1:0": 128_000,
  "deepseek.v3.2": 128_000,
  // Cohere
  "cohere.command-r-plus-v1:0": 128_000,
  "cohere.command-r-v1:0": 128_000,
  // AI21
  "ai21.jamba-1-5-large-v1:0": 256_000,
  "ai21.jamba-1-5-mini-v1:0": 256_000,
  // Google Gemma
  "google.gemma-3-27b-it": 128_000,
  "google.gemma-3-12b-it": 128_000,
  "google.gemma-3-4b-it": 128_000,
  // GLM
  "zai.glm-5": 128_000,
  "zai.glm-4.7": 128_000,
  "zai.glm-4.7-flash": 128_000,
  // Qwen
  "qwen.qwen3-coder-next": 256_000,
  "qwen.qwen3-coder-30b-a3b-v1:0": 256_000,
  "qwen.qwen3-32b-v1:0": 128_000,
  "qwen.qwen3-vl-235b-a22b": 128_000,
};

/**
 * Resolve the real context window for a Bedrock model ID.
 * Strips inference profile prefixes (us., eu., ap., global.) before lookup.
 */
function resolveKnownContextWindow(modelId: string): number | undefined {
  const stripped = modelId.replace(/^(?:us|eu|ap|apac|au|jp|global)\./, "");
  const candidates = [modelId, stripped];
  for (const candidate of candidates) {
    if (isClaude5BedrockModel({ id: candidate })) {
      return 1_000_000;
    }
    if (/(?:^|[/.:])anthropic\.claude-opus-4[.-]8(?:$|[-.:/])/i.test(candidate)) {
      return 1_000_000;
    }
    if (KNOWN_CONTEXT_WINDOWS[candidate] !== undefined) {
      return KNOWN_CONTEXT_WINDOWS[candidate];
    }
    const withoutVersionSuffix = candidate.replace(/:0$/, "");
    if (
      withoutVersionSuffix !== candidate &&
      KNOWN_CONTEXT_WINDOWS[withoutVersionSuffix] !== undefined
    ) {
      return KNOWN_CONTEXT_WINDOWS[withoutVersionSuffix];
    }
  }
  return undefined;
}

function isKnownClaudeMythosPreviewModelId(modelId: string): boolean {
  const stripped = modelId.replace(/^(?:us|eu|ap|apac|au|jp|global)\./, "");
  return [modelId, stripped].some((candidate) =>
    /(?:^|[/.:])anthropic\.claude-mythos-preview(?:$|[-.:/])/i.test(candidate),
  );
}

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
  result: Promise<ModelDefinitionConfig[]>;
};

const discoveryCache = new Map<string, BedrockDiscoveryCacheEntry>();

/**
 * Fetch raw inference profile summaries from the Bedrock control plane.
 * All pages must succeed before discovery can cache a complete catalog.
 */
async function fetchInferenceProfileSummaries(
  client: BedrockClient,
  createListInferenceProfilesCommand: BedrockControlPlaneSdk["createListInferenceProfilesCommand"],
): Promise<InferenceProfileSummary[]> {
  const profiles: InferenceProfileSummary[] = [];
  let nextToken: string | undefined;
  do {
    const command = createListInferenceProfilesCommand({ nextToken });
    const response = await runBedrockControlPlaneRequest({
      operation: "Bedrock ListInferenceProfiles",
      send: (options) => client.send(command, options),
    });
    for (const summary of response.inferenceProfileSummaries ?? []) {
      profiles.push(summary);
    }
    nextToken = response.nextToken;
  } while (nextToken);
  return profiles;
}

/** Public discovery is advisory by default; catalog owners opt into strict acquisition. */
export async function discoverBedrockModels(params: {
  region: string;
  discoveryMode?: "strict";
  config?: BedrockDiscoveryConfig;
}): Promise<ModelDefinitionConfig[]> {
  const refreshIntervalSeconds = Math.max(
    0,
    Math.floor(params.config?.refreshInterval ?? DEFAULT_REFRESH_INTERVAL_SECONDS),
  );
  const providerFilter = normalizeSortedUniqueTrimmedStringList(
    params.config?.providerFilter?.map(normalizeOptionalLowercaseString),
  );
  const contextWindow = Math.floor(params.config?.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW);
  const maxTokens = Math.floor(params.config?.defaultMaxTokens ?? DEFAULT_MAX_TOKENS);
  const defaultContextWindow = contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT_WINDOW;
  const defaultMaxTokens = maxTokens > 0 ? maxTokens : DEFAULT_MAX_TOKENS;
  const cacheKey = JSON.stringify({
    region: params.region,
    discoveryMode: params.discoveryMode,
    providerFilter,
    refreshIntervalSeconds,
    defaultContextWindow,
    defaultMaxTokens,
  });
  const now = Date.now();

  if (refreshIntervalSeconds > 0) {
    const cached = discoveryCache.get(cacheKey);
    if (cached && isFutureDateTimestampMs(cached.expiresAt, { nowMs: now })) {
      return cached.result;
    }
    discoveryCache.delete(cacheKey);
  }

  const sdk = await loadBedrockControlPlaneSdk();
  const client = sdk.createClient(params.region);

  const discoveryPromise = (async () => {
    try {
      const foundationCommand = sdk.createListFoundationModelsCommand();
      const [foundationResponse, profileSummaries] = await Promise.all([
        runBedrockControlPlaneRequest({
          operation: "Bedrock ListFoundationModels",
          send: (options) => client.send(foundationCommand, options),
        }),
        fetchInferenceProfileSummaries(client, (input) =>
          sdk.createListInferenceProfilesCommand(input),
        ).catch((error: unknown) => {
          if (params.discoveryMode === "strict") {
            throw error;
          }
          discoveryCache.delete(cacheKey);
          return [];
        }),
      ]);

      const discovered: ModelDefinitionConfig[] = [];
      const seenIds = new Set<string>();
      const foundationModels = new Map<string, ModelDefinitionConfig>();

      for (const summary of foundationResponse.modelSummaries ?? []) {
        if (!summary.modelId?.trim()) {
          continue;
        }
        if (providerFilter.length > 0) {
          const providerName =
            summary.providerName ??
            (typeof summary.modelId === "string" ? summary.modelId.split(".")[0] : undefined);
          const provider = normalizeOptionalLowercaseString(providerName);
          if (!provider || !providerFilter.includes(provider)) {
            continue;
          }
        }
        if (
          summary.responseStreamingSupported !== true ||
          isKnownClaudeMythosPreviewModelId(summary.modelId) ||
          !(summary.outputModalities ?? []).some(
            (entry) => normalizeOptionalLowercaseString(entry) === "text",
          ) ||
          typeof summary.modelLifecycle?.status !== "string" ||
          summary.modelLifecycle.status.toUpperCase() !== "ACTIVE"
        ) {
          continue;
        }
        const input = (summary.inputModalities ?? [])
          .map(normalizeOptionalLowercaseString)
          .filter((modality) => modality === "text" || modality === "image");
        const reasoningHint = normalizeLowercaseStringOrEmpty(
          `${summary.modelId ?? ""} ${summary.modelName ?? ""}`,
        );
        const id = summary.modelId?.trim() ?? "";
        const thinkingLevelMap = resolveBedrockNativeThinkingLevelMap(id);
        const def: ModelDefinitionConfig = {
          id,
          name: summary.modelName?.trim() || id,
          reasoning:
            supportsClaudeAdaptiveThinking({ id: summary.modelId }) ||
            reasoningHint.includes("reasoning") ||
            reasoningHint.includes("thinking"),
          input: input.length > 0 ? [...new Set(input)] : ["text"],
          cost: DEFAULT_COST,
          contextWindow: resolveKnownContextWindow(id) ?? defaultContextWindow,
          maxTokens: isClaude5BedrockModel({ id }) ? 128_000 : defaultMaxTokens,
          ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
        };
        discovered.push(def);
        const normalizedId = normalizeLowercaseStringOrEmpty(def.id);
        seenIds.add(normalizedId);
        foundationModels.set(normalizedId, def);
      }

      for (const profile of profileSummaries) {
        if (!profile.inferenceProfileId?.trim()) {
          continue;
        }
        if (profile.status !== "ACTIVE") {
          continue;
        }

        // Apply provider filter: check if any of the underlying models match.
        if (providerFilter.length > 0) {
          const models = profile.models ?? [];
          const matchesFilter = models.some((m) => {
            const provider = m.modelArn?.split("/")?.[1]?.split(".")?.[0];
            return provider
              ? providerFilter.includes(normalizeOptionalLowercaseString(provider) ?? "")
              : false;
          });
          if (!matchesFilter) {
            continue;
          }
        }

        // Look up the underlying foundation model to inherit its capabilities.
        const baseModelId =
          /foundation-model\/(.+)$/.exec(profile.models?.[0]?.modelArn ?? "")?.[1] ??
          (profile.type === "SYSTEM_DEFINED"
            ? /^(?:us|eu|ap|apac|au|jp|global)\.(.+)$/i.exec(profile.inferenceProfileId ?? "")?.[1]
            : undefined);
        if (isKnownClaudeMythosPreviewModelId(baseModelId ?? profile.inferenceProfileId)) {
          continue;
        }
        const baseModel = baseModelId
          ? foundationModels.get(normalizeLowercaseStringOrEmpty(baseModelId))
          : undefined;
        const knownThinkingLevelMap = resolveBedrockNativeThinkingLevelMap(
          baseModelId ?? profile.inferenceProfileId,
        );
        const contractModelId = baseModelId ?? profile.inferenceProfileId;
        const claude5 = isClaude5BedrockModel({ id: contractModelId });
        const canonicalClaudeId = resolveClaudeModelIdentity({ id: baseModelId });

        const definition: ModelDefinitionConfig = {
          id: profile.inferenceProfileId,
          name: profile.inferenceProfileName?.trim() || profile.inferenceProfileId,
          reasoning:
            baseModel?.reasoning ??
            supportsClaudeAdaptiveThinking({ id: baseModelId ?? profile.inferenceProfileId }),
          input: baseModel?.input ?? (claude5 ? ["text", "image"] : ["text"]),
          cost: baseModel?.cost ?? DEFAULT_COST,
          contextWindow:
            baseModel?.contextWindow ??
            resolveKnownContextWindow(contractModelId) ??
            defaultContextWindow,
          maxTokens: baseModel?.maxTokens ?? (claude5 ? 128_000 : defaultMaxTokens),
          ...(baseModel?.thinkingLevelMap || knownThinkingLevelMap
            ? { thinkingLevelMap: baseModel?.thinkingLevelMap ?? knownThinkingLevelMap }
            : {}),
          ...(canonicalClaudeId.startsWith("claude-")
            ? { params: { canonicalModelId: canonicalClaudeId } }
            : {}),
        };
        const normalizedId = normalizeLowercaseStringOrEmpty(definition.id);
        if (!seenIds.has(normalizedId)) {
          discovered.push(definition);
          seenIds.add(normalizedId);
        }
      }

      // Sort: global cross-region profiles first (recommended for most users —
      // better capacity, automatic failover, no data sovereignty constraints),
      // then remaining profiles/models alphabetically.
      return discovered.toSorted((a, b) => {
        const aGlobal = a.id.startsWith("global.") ? 0 : 1;
        const bGlobal = b.id.startsWith("global.") ? 0 : 1;
        if (aGlobal !== bGlobal) {
          return aGlobal - bGlobal;
        }
        return a.name.localeCompare(b.name);
      });
    } catch (error) {
      const status = asOptionalRecord(asOptionalRecord(error)?.$metadata)?.httpStatusCode;
      if (typeof status === "number") {
        throw new LiveModelCatalogHttpError("amazon-bedrock", status);
      }
      throw error;
    } finally {
      // Discovery owns the short-lived control-plane client and its socket agents.
      client.destroy();
    }
  })().catch((error: unknown) => {
    discoveryCache.delete(cacheKey);
    if (params.discoveryMode === "strict") {
      throw error;
    }
    return [];
  });

  if (refreshIntervalSeconds > 0) {
    const expiresAt = resolveExpiresAtMsFromDurationSeconds(refreshIntervalSeconds, { nowMs: now });
    if (expiresAt !== undefined) {
      discoveryCache.set(cacheKey, {
        expiresAt,
        result: discoveryPromise,
      });
    }
  }

  return discoveryPromise;
}

/** Public resolution keeps advisory null results; strict catalog callers retain acquired empties. */
export async function resolveImplicitBedrockProvider(params: {
  pluginConfig?: { discovery?: BedrockDiscoveryConfig };
  discoveryMode?: "strict";
  env?: NodeJS.ProcessEnv;
}): Promise<ModelProviderConfig | null> {
  const env = params.env ?? process.env;
  const discoveryConfig = params.pluginConfig?.discovery;
  const enabled = discoveryConfig?.enabled;
  const hasAwsCreds = resolveAwsSdkEnvVarName(env) !== undefined;
  if (enabled === false) {
    return null;
  }
  if (enabled !== true && !hasAwsCreds) {
    return null;
  }

  const region =
    discoveryConfig?.region ??
    normalizeOptionalString(env.AWS_REGION) ??
    normalizeOptionalString(env.AWS_DEFAULT_REGION) ??
    "us-east-1";
  const models = await discoverBedrockModels({
    region,
    discoveryMode: params.discoveryMode,
    config: discoveryConfig,
  });
  if (models.length === 0 && params.discoveryMode !== "strict") {
    return null;
  }
  return {
    baseUrl: `https://bedrock-runtime.${region}.amazonaws.com`,
    api: "bedrock-converse-stream",
    auth: "aws-sdk",
    models,
  };
}
