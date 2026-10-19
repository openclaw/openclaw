import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeOpenRouterModelFamilyId } from "openclaw/plugin-sdk/model-ref-parse";
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
  ProviderNormalizeToolSchemasContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { findNormalizedProviderValue } from "openclaw/plugin-sdk/provider-auth";
import { runLiveProviderCatalog } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import {
  buildPassthroughGeminiSanitizingReplayPolicy,
  DEFAULT_CONTEXT_TOKENS,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  getLoadedOpenRouterModelCapabilities,
  loadOpenRouterModelCapabilities,
} from "openclaw/plugin-sdk/provider-stream-family";
import {
  buildProviderToolCompatFamilyHooks,
  SCHEMA_MAP_KEYS,
  SCHEMA_NESTED_KEYS,
} from "openclaw/plugin-sdk/provider-tools";
import { resolveProviderUsageApiKeyAuth } from "openclaw/plugin-sdk/provider-usage";
import { asOptionalRecord as readRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { buildOpenRouterDecisionProvider, isOpenRouterDecisionModel } from "./decision-provider.js";
import { buildOpenRouterImageGenerationProvider } from "./image-generation-provider.js";
import { openrouterMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { isOpenRouterMistralModelId, normalizeOpenRouterApiModelId } from "./models.js";
import { buildOpenRouterMusicGenerationProvider } from "./music-generation-provider.js";
import { createOpenRouterOAuthAuthMethod } from "./oauth.js";
import { applyOpenrouterConfig, OPENROUTER_DEFAULT_MODEL_REF } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import {
  buildOpenrouterLiveProvider,
  buildOpenrouterProvider,
  isOpenRouterProxyReasoningUnsupportedModel,
  normalizeOpenRouterBaseUrl,
  OPENROUTER_BASE_URL,
  resolveOpenRouterApiBaseUrl,
} from "./provider-catalog.js";
import {
  resolveOpenRouterConfiguredExtraParams,
  resolveOpenRouterExtraParamsForTransport,
} from "./provider-routing.js";
import { buildOpenRouterSpeechProvider } from "./speech-provider.js";
import { wrapOpenRouterProviderStream } from "./stream.js";
import { resolveOpenRouterThinkingProfile } from "./thinking-policy.js";
import { fetchOpenRouterUsage } from "./usage.js";
import {
  buildOpenRouterVideoGenerationProvider,
  listOpenRouterVideoModelCatalog,
} from "./video-generation-provider.js";

const openAiTools = buildProviderToolCompatFamilyHooks("openai");
const schemaTypes = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);

function readSchemaTypes(type: unknown): string[] | undefined {
  const types = Array.isArray(type) ? type : [type];
  return types.length > 0 &&
    types.every((entry) => typeof entry === "string" && schemaTypes.has(entry))
    ? types
    : undefined;
}

function canMoveParentType(branches: unknown[], parentTypes: string[]): boolean {
  return (
    branches.length > 0 &&
    branches.every((branch) => {
      const record = readRecord(branch);
      // Unknown references, boolean schemas and nested unions cannot safely inherit a type.
      if (!record || "$ref" in record || "anyOf" in record || "oneOf" in record) {
        return false;
      }
      if (!("type" in record)) {
        return true;
      }
      return (
        readSchemaTypes(record.type)?.every(
          (type) =>
            parentTypes.includes(type) || (type === "integer" && parentTypes.includes("number")),
        ) === true
      );
    })
  );
}

function normalizeMoonshotSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map(normalizeMoonshotSchema);
  }
  const record = readRecord(schema);
  if (!record) {
    return schema;
  }
  return normalizeMoonshotSchemaObject(record);
}

function normalizeMoonshotSchemaObject(record: Record<string, unknown>): Record<string, unknown> {
  // Traverse schema locations only: default/examples/enum can contain arbitrary user data.
  // fromEntries preserves own __proto__ keys without invoking Object.prototype setters.
  const next = Object.fromEntries(
    Object.entries(record).map(([key, value]) => {
      const entries = SCHEMA_MAP_KEYS.has(key) ? readRecord(value) : undefined;
      if (entries) {
        return [
          key,
          Object.fromEntries(
            Object.entries(entries).map(([name, child]) => [name, normalizeMoonshotSchema(child)]),
          ),
        ];
      }
      return [key, SCHEMA_NESTED_KEYS.has(key) ? normalizeMoonshotSchema(value) : value];
    }),
  );
  const parentTypes = readSchemaTypes(next.type);
  const branches = next.anyOf;
  if (!parentTypes || !Array.isArray(branches) || !canMoveParentType(branches, parentTypes)) {
    return next;
  }
  // Moonshot requires anyOf branch types. Distribute the parent's conjunctive type only
  // when every typed branch is already a subset; retain all other parent constraints.
  // oneOf has no evidenced rewrite here. Never apply DeepSeek's first-branch reduction.
  const { type, ...result } = next;
  const typedBranches: unknown[] = [];
  for (const branch of branches) {
    const branchRecord = readRecord(branch);
    typedBranches.push(
      branchRecord && !("type" in branchRecord) ? { type, ...branchRecord } : branch,
    );
  }
  result.anyOf = typedBranches;
  return result;
}

const moonshotTools = {
  normalizeToolSchemas: (ctx: ProviderNormalizeToolSchemasContext) =>
    ctx.tools.map((tool) => {
      const parameters = readRecord(tool.parameters);
      return parameters ? { ...tool, parameters: normalizeMoonshotSchemaObject(parameters) } : tool;
    }),
  // Retained unions are valid schema contracts, not DeepSeek-incompatible diagnostics.
  inspectToolSchemas: (_ctx: ProviderNormalizeToolSchemasContext) => [],
};

function resolveOpenRouterToolFamily(modelId: string) {
  const normalized =
    normalizeOpenRouterModelFamilyId(normalizeOpenRouterApiModelId(modelId)) ?? modelId;
  if (normalized.startsWith("moonshot/") || normalized.startsWith("moonshotai/")) {
    return moonshotTools;
  }
  return openAiTools;
}

const PROVIDER_ID = "openrouter";
const OPENROUTER_DEFAULT_MAX_TOKENS = 8192;
const OPENROUTER_FUSION_MODEL_ID = "openrouter/fusion";
// Upstream families with OpenRouter prompt caching, so pruning waits out the cache TTL.
// OpenRouter documents implicit Gemini caching only for the 2.5 series and newer.
const OPENROUTER_CACHE_TTL_MODEL_FAMILY =
  /^(?:(?:anthropic|deepseek|moonshot(?:ai)?|x-ai|z-?ai)\/|google\/gemini-(?:2\.5|3))/;
const MAX_PROMPT_MODEL_ID_DISPLAY_CHARS = 256;

// Configured rows keep their sizing and opt-outs, but the OpenRouter model
// catalog owns effort capabilities on its canonical transport.
function isOpenRouterCatalogRoute(route: {
  api?: string | null;
  baseUrl?: string | null;
}): boolean {
  return (
    (route.api == null || route.api === "openai-completions") &&
    // Target-provider resolution may compare routes before normalizing a
    // legacy URL, so only the exact catalog route can borrow its metadata.
    (route.baseUrl == null || route.baseUrl === OPENROUTER_BASE_URL)
  );
}

function withOpenRouterCatalogThinking(
  ctx: ProviderDefaultThinkingPolicyContext,
): ProviderDefaultThinkingPolicyContext {
  if (
    ctx.thinkingLevelMap ||
    ctx.compat?.supportsReasoningEffort !== undefined ||
    ctx.compat?.supportedReasoningEfforts !== undefined ||
    !isOpenRouterCatalogRoute(ctx)
  ) {
    return ctx;
  }
  // Thinking profiles run on synchronous session reads, so they only consume
  // catalog capabilities already loaded in memory.
  const capabilities = getLoadedOpenRouterModelCapabilities(
    normalizeOpenRouterApiModelId(ctx.modelId) ?? ctx.modelId,
  );
  if (!capabilities?.compat && !capabilities?.thinkingLevelMap) {
    return ctx;
  }
  return {
    ...ctx,
    compat: { ...capabilities.compat, ...ctx.compat },
    ...(capabilities.thinkingLevelMap ? { thinkingLevelMap: capabilities.thinkingLevelMap } : {}),
  };
}

type OpenRouterFusionPromptContext = {
  config?: OpenClawConfig;
  agentId?: string;
  modelId: string;
};

type OpenRouterFusionPromptContribution = {
  dynamicSuffix?: string;
};

function normalizeOpenRouterResolvedModel<T extends ProviderRuntimeModel>(model: T): T | undefined {
  const normalizedBaseUrl = normalizeOpenRouterBaseUrl(model.baseUrl);
  const normalizedId = normalizeOpenRouterApiModelId(model.id);
  const reasoning = isOpenRouterProxyReasoningUnsupportedModel(model.id) ? false : model.reasoning;
  if (
    (!normalizedBaseUrl || normalizedBaseUrl === model.baseUrl) &&
    (!normalizedId || normalizedId === model.id) &&
    reasoning === model.reasoning
  ) {
    return undefined;
  }
  return {
    ...model,
    ...(normalizedId ? { id: normalizedId } : {}),
    ...(normalizedBaseUrl ? { baseUrl: normalizedBaseUrl } : {}),
    reasoning,
  };
}

function sanitizePromptModelId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = truncateUtf16Safe(
    value.replace(/[\p{Cc}\u2028\u2029]/gu, "").trim(),
    MAX_PROMPT_MODEL_ID_DISPLAY_CHARS,
  );
  return normalized || undefined;
}

function resolveFusionExtraBody(
  ctx: OpenRouterFusionPromptContext,
): Record<string, unknown> | undefined {
  const params = resolveOpenRouterConfiguredExtraParams(ctx);
  return params
    ? readRecord(Object.hasOwn(params, "extra_body") ? params.extra_body : params.extraBody)
    : undefined;
}

function resolveOpenRouterFusionPromptContribution(
  ctx: OpenRouterFusionPromptContext,
): OpenRouterFusionPromptContribution | undefined {
  const normalizedModelId = normalizeOpenRouterApiModelId(ctx.modelId) ?? ctx.modelId;
  if (normalizedModelId !== OPENROUTER_FUSION_MODEL_ID) {
    return undefined;
  }

  const extraBody = resolveFusionExtraBody(ctx);
  const fusionPlugin = Array.isArray(extraBody?.plugins)
    ? extraBody.plugins.map(readRecord).find((plugin) => plugin?.id === "fusion")
    : undefined;
  if (!fusionPlugin || fusionPlugin.enabled === false) {
    return undefined;
  }

  const analysisModels = Array.isArray(fusionPlugin.analysis_models)
    ? fusionPlugin.analysis_models
        .map(sanitizePromptModelId)
        .filter((model): model is string => Boolean(model))
    : [];
  const finalModel = sanitizePromptModelId(fusionPlugin.model);
  const lines = [
    "## OpenRouter Fusion Configuration",
    "The active OpenRouter Fusion request is configured with these non-secret Fusion plugin fields.",
    analysisModels.length > 0 ? `Analysis models: ${analysisModels.join(", ")}.` : undefined,
    finalModel ? `Final Fusion model: ${finalModel}.` : undefined,
  ].filter((line): line is string => Boolean(line));

  return lines.length > 2 ? { dynamicSuffix: lines.join("\n") } : undefined;
}

export default defineSingleProviderPluginEntry({
  id: "openrouter",
  name: "OpenRouter Provider",
  description: "Bundled OpenRouter provider plugin",
  manifest,
  provider() {
    function buildDynamicOpenRouterModel(
      ctx: ProviderResolveDynamicModelContext,
    ): ProviderRuntimeModel {
      const apiModelId = normalizeOpenRouterApiModelId(ctx.modelId) ?? ctx.modelId;
      const capabilities = getLoadedOpenRouterModelCapabilities(apiModelId);
      return {
        id: ctx.modelId,
        name: capabilities?.name ?? ctx.modelId,
        api: "openai-completions",
        provider: PROVIDER_ID,
        baseUrl: resolveOpenRouterApiBaseUrl(
          ctx.providerConfig?.baseUrl ?? ctx.config?.models?.providers?.openrouter?.baseUrl,
        ),
        reasoning:
          (capabilities?.reasoning ?? false) &&
          !isOpenRouterProxyReasoningUnsupportedModel(ctx.modelId),
        input: capabilities?.input ?? ["text"],
        ...(capabilities?.compat || capabilities?.supportsTools !== undefined
          ? {
              compat: {
                ...capabilities.compat,
                ...(capabilities.supportsTools !== undefined
                  ? { supportsTools: capabilities.supportsTools }
                  : {}),
              },
            }
          : {}),
        ...(capabilities?.thinkingLevelMap
          ? { thinkingLevelMap: capabilities.thinkingLevelMap }
          : {}),
        cost: capabilities?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: capabilities?.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
        maxTokens: capabilities?.maxTokens ?? OPENROUTER_DEFAULT_MAX_TOKENS,
      };
    }

    return {
      label: "OpenRouter",
      docsPath: "/providers/models",
      manifestAuth: {
        hint: "API key",
        defaultModel: OPENROUTER_DEFAULT_MODEL_REF,
        applyConfig: applyOpenrouterConfig,
      },
      extraAuth: [createOpenRouterOAuthAuthMethod()],
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const auth = ctx.resolveProviderApiKey(PROVIDER_ID);
          const apiKey = auth.apiKey;
          if (!apiKey) {
            return null;
          }
          const providerConfig = ctx.config.models?.providers?.openrouter;
          return await runLiveProviderCatalog({
            providerId: PROVIDER_ID,
            profileId: auth.profileId,
            run: async () => ({
              provider: await buildOpenrouterLiveProvider({
                apiKey,
                discoveryApiKey: auth.discoveryApiKey,
                baseUrl: providerConfig?.baseUrl,
                request: providerConfig?.request,
              }),
            }),
          });
        },
        staticRun: async (ctx) => {
          // Configured OpenRouter models complete from this catalog through synchronous
          // capability reads, and thinking levels are chosen from that row. Load capabilities
          // first (persisted catalog, or one fetch) only when a caller selected OpenRouter.
          if (ctx.providerIds?.includes(PROVIDER_ID)) {
            await loadOpenRouterModelCapabilities(OPENROUTER_DEFAULT_MODEL_REF);
          }
          return { provider: buildOpenrouterProvider() };
        },
      },
      resolveDynamicModel: (ctx) =>
        isOpenRouterDecisionModel(normalizeOpenRouterApiModelId(ctx.modelId) ?? ctx.modelId)
          ? undefined
          : buildDynamicOpenRouterModel(ctx),
      // Resolve the catalog model even when a configured row already exists.
      preferRuntimeResolvedModel: (ctx) => {
        const configuredProvider = findNormalizedProviderValue(
          ctx.config?.models?.providers,
          PROVIDER_ID,
        );
        const requestedId = normalizeOpenRouterApiModelId(ctx.modelId) ?? ctx.modelId;
        const configuredModel = configuredProvider?.models?.find(
          (model) => (normalizeOpenRouterApiModelId(model.id) ?? model.id) === requestedId,
        );
        return (
          configuredModel !== undefined &&
          isOpenRouterCatalogRoute({
            api: configuredModel.api ?? configuredProvider?.api,
            baseUrl: configuredModel.baseUrl ?? configuredProvider?.baseUrl,
          })
        );
      },
      prepareDynamicModel: async (ctx) => {
        if (isOpenRouterDecisionModel(normalizeOpenRouterApiModelId(ctx.modelId) ?? ctx.modelId)) {
          return;
        }
        await loadOpenRouterModelCapabilities(
          normalizeOpenRouterApiModelId(ctx.modelId) ?? ctx.modelId,
        );
      },
      normalizeConfig: ({ providerConfig }) => {
        const normalizedBaseUrl = normalizeOpenRouterBaseUrl(providerConfig.baseUrl);
        return normalizedBaseUrl && normalizedBaseUrl !== providerConfig.baseUrl
          ? { ...providerConfig, baseUrl: normalizedBaseUrl }
          : undefined;
      },
      normalizeResolvedModel: ({ model }) => normalizeOpenRouterResolvedModel(model),
      normalizeTransport: ({ api: apiLocal, baseUrl }) => {
        const normalizedBaseUrl = normalizeOpenRouterBaseUrl(baseUrl);
        return normalizedBaseUrl && normalizedBaseUrl !== baseUrl
          ? {
              api: apiLocal,
              baseUrl: normalizedBaseUrl,
            }
          : undefined;
      },
      classifyFailoverReason: ({ provider, errorMessage }) => {
        if (provider?.trim().toLowerCase() !== PROVIDER_ID) {
          return undefined;
        }
        if (
          /\b(?:api\s+key\s+budget|key)\s+limit\s*(?:exceeded|reached|hit)\b/i.test(errorMessage)
        ) {
          return "billing";
        }
        return /provider returned error/i.test(errorMessage) ? "timeout" : undefined;
      },
      buildReplayPolicy: ({ modelId }) => ({
        ...buildPassthroughGeminiSanitizingReplayPolicy(modelId),
        // Mistral requires 9-character base62 tool-call ids even through OpenRouter (#58012).
        ...(isOpenRouterMistralModelId(modelId)
          ? { sanitizeToolCallIds: true, toolCallIdMode: "strict9" as const }
          : {}),
      }),
      normalizeToolSchemas: (ctx) =>
        resolveOpenRouterToolFamily(ctx.modelId ?? "").normalizeToolSchemas(ctx),
      inspectToolSchemas: (ctx) =>
        resolveOpenRouterToolFamily(ctx.modelId ?? "").inspectToolSchemas(ctx),
      resolveReasoningOutputMode: () => "native",
      resolveThinkingProfile: (ctx) =>
        resolveOpenRouterThinkingProfile(ctx.modelId, withOpenRouterCatalogThinking(ctx)),
      isModernModelRef: () => true,
      resolveSystemPromptContribution: resolveOpenRouterFusionPromptContribution,
      extraParamsForTransport: resolveOpenRouterExtraParamsForTransport,
      wrapStreamFn: wrapOpenRouterProviderStream,
      wrapSimpleCompletionStreamFn: wrapOpenRouterProviderStream,
      isCacheTtlEligible: ({ modelId }) =>
        OPENROUTER_CACHE_TTL_MODEL_FAMILY.test(normalizeOpenRouterModelFamilyId(modelId) ?? ""),
      resolveUsageAuth: (ctx) => resolveProviderUsageApiKeyAuth(ctx, [ctx.env.OPENROUTER_API_KEY]),
      fetchUsageSnapshot: async (ctx) =>
        await fetchOpenRouterUsage({
          token: ctx.token,
          baseUrl: ctx.config.models?.providers?.openrouter?.baseUrl,
          request: ctx.config.models?.providers?.openrouter?.request,
          timeoutMs: ctx.timeoutMs,
          signal: ctx.signal,
          fetchFn: ctx.fetchFn,
        }),
    };
  },
  register(api) {
    api.registerDecisionProvider(buildOpenRouterDecisionProvider());
    api.registerMediaUnderstandingProvider(openrouterMediaUnderstandingProvider);
    api.registerImageGenerationProvider(buildOpenRouterImageGenerationProvider());
    api.registerMusicGenerationProvider(buildOpenRouterMusicGenerationProvider());
    api.registerVideoGenerationProvider(buildOpenRouterVideoGenerationProvider());
    api.registerModelCatalogProvider({
      provider: PROVIDER_ID,
      kinds: ["video_generation"],
      liveCatalog: listOpenRouterVideoModelCatalog,
    });
    api.registerSpeechProvider(buildOpenRouterSpeechProvider());
  },
});
