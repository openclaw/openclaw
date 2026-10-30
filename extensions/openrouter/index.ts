import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
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
  readProviderJsonResponse,
  resolveProviderHttpRequestConfig,
  sanitizeConfiguredModelProviderRequest,
} from "openclaw/plugin-sdk/provider-http";
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
import {
  buildUsageHttpErrorSnapshot,
  parseProviderUsageNonNegativeNumber,
  resolveProviderUsageApiKeyAuth,
  type ProviderUsageSnapshot,
} from "openclaw/plugin-sdk/provider-usage";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
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
  resolveOpenRouterSsrfPolicy,
} from "./provider-catalog.js";
import {
  resolveOpenRouterConfiguredExtraParams,
  resolveOpenRouterExtraParamsForTransport,
} from "./provider-routing.js";
import { buildOpenRouterSpeechProvider } from "./speech-provider.js";
import { wrapOpenRouterProviderStream } from "./stream.js";
import { resolveOpenRouterThinkingProfile } from "./thinking-policy.js";
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
const OPENROUTER_USAGE_RESPONSE_MAX_BYTES = 1024 * 1024;

type EndpointResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; status: number }
  | { ok: false; reason: "malformed" }
  | { ok: false; reason: "transport"; error: string };

type OpenRouterLimitReset = "daily" | "weekly" | "monthly";

function resolveLimitReset(value: unknown): OpenRouterLimitReset | undefined {
  return value === "daily" || value === "weekly" || value === "monthly" ? value : undefined;
}

function resolveKeyBudget(
  data: Record<string, unknown> | undefined,
): { used: number; limit: number; period?: OpenRouterLimitReset } | undefined {
  const limit = parseProviderUsageNonNegativeNumber(data?.limit);
  if (limit === undefined) {
    return undefined;
  }
  const period = resolveLimitReset(data?.limit_reset);
  const periodUsage = parseProviderUsageNonNegativeNumber(
    period ? data?.[`usage_${period}`] : data?.usage,
  );
  const byokUsage =
    data?.include_byok_in_limit !== true
      ? undefined
      : parseProviderUsageNonNegativeNumber(
          period ? data[`byok_usage_${period}`] : data.byok_usage,
        );
  const remaining = parseProviderUsageNonNegativeNumber(data?.limit_remaining);
  // `limit_remaining` already incorporates BYOK usage when the key is configured to count it.
  const usage =
    periodUsage === undefined && byokUsage === undefined
      ? undefined
      : (periodUsage ?? 0) + (byokUsage ?? 0);
  const used = remaining === undefined ? usage : Math.max(0, limit - remaining);
  return used === undefined ? undefined : { used, limit, ...(period ? { period } : {}) };
}

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

function normalizeRouterBaseUrl<T extends { baseUrl?: string }>(value: T) {
  const baseUrl = normalizeOpenRouterBaseUrl(value.baseUrl);
  return baseUrl && baseUrl !== value.baseUrl ? { ...value, baseUrl } : undefined;
}

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
      normalizeConfig: ({ providerConfig }) => normalizeRouterBaseUrl(providerConfig),
      normalizeResolvedModel: ({ model }) => normalizeOpenRouterResolvedModel(model),
      normalizeTransport: ({ api, baseUrl }) => normalizeRouterBaseUrl({ api, baseUrl }),
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
      fetchUsageSnapshot: async (ctx) => {
        const providerConfig = ctx.config.models?.providers?.openrouter;
        const requestConfig = resolveProviderHttpRequestConfig({
          provider: "openrouter",
          capability: "other",
          baseUrl: resolveOpenRouterApiBaseUrl(providerConfig?.baseUrl),
          defaultBaseUrl: OPENROUTER_BASE_URL,
          defaultHeaders: {
            Accept: "application/json",
            Authorization: `Bearer ${ctx.token}`,
          },
          request: sanitizeConfiguredModelProviderRequest(providerConfig?.request),
        });
        const ssrfPolicy = resolveOpenRouterSsrfPolicy(requestConfig, providerConfig?.request);
        async function fetchEndpoint(path: "credits" | "key"): Promise<EndpointResult> {
          let guardedResponse: Awaited<ReturnType<typeof fetchWithSsrFGuard>>;
          try {
            guardedResponse = await fetchWithSsrFGuard({
              url: `${requestConfig.baseUrl}/${path}`,
              // Ambient proxy fetch wrappers replace dispatchers, so configured provider transport wins.
              ...(requestConfig.dispatcherPolicy
                ? { dispatcherPolicy: requestConfig.dispatcherPolicy }
                : { fetchImpl: ctx.fetchFn }),
              init: { headers: requestConfig.headers, redirect: "error" },
              timeoutMs: ctx.timeoutMs,
              signal: ctx.signal,
              // The shared guard controls redirects manually; zero hops preserves fail-closed usage auth.
              maxRedirects: 0,
              policy: ssrfPolicy,
              auditContext: "openrouter-usage",
            });
          } catch (error) {
            return { ok: false, reason: "transport", error: formatErrorMessage(error) };
          }
          try {
            const { response } = guardedResponse;
            if (!response.ok) {
              // release() aborts transport before cancelling unread capture-tee bodies.
              // Awaiting one branch here can hold the error result until the other ends.
              return { ok: false, status: response.status };
            }
            const root = readRecord(
              await readProviderJsonResponse(response, "OpenRouter usage", {
                maxBytes: OPENROUTER_USAGE_RESPONSE_MAX_BYTES,
                chunkTimeoutMs: 0,
              }),
            );
            const data = readRecord(root?.data);
            return data ? { ok: true, data } : { ok: false, reason: "malformed" };
          } catch {
            return { ok: false, reason: "malformed" };
          } finally {
            await guardedResponse.release();
          }
        }
        const [creditsResult, keyResult] = await Promise.all([
          fetchEndpoint("credits"),
          fetchEndpoint("key"),
        ]);
        if (!creditsResult.ok && !keyResult.ok) {
          const status =
            "status" in creditsResult
              ? creditsResult.status
              : "status" in keyResult
                ? keyResult.status
                : undefined;
          if (status !== undefined) {
            return buildUsageHttpErrorSnapshot({ provider: "openrouter", status });
          }
          const transportFailure = [creditsResult, keyResult].find(
            (result) => "reason" in result && result.reason === "transport",
          );
          return {
            provider: "openrouter",
            displayName: "OpenRouter",
            windows: [],
            error: transportFailure
              ? `Usage unavailable: ${transportFailure.error}`
              : "Malformed usage response",
          };
        }
        const credits = creditsResult.ok ? creditsResult.data : undefined;
        const key = keyResult.ok ? keyResult.data : undefined;
        const totalCredits = parseProviderUsageNonNegativeNumber(credits?.total_credits);
        const totalUsage = parseProviderUsageNonNegativeNumber(credits?.total_usage);
        const keyUsage = parseProviderUsageNonNegativeNumber(key?.usage);
        const keyBudget = resolveKeyBudget(key);
        const windows = [];
        if (keyBudget) {
          const periodLabel = keyBudget.period
            ? `${keyBudget.period[0]?.toUpperCase()}${keyBudget.period.slice(1)} key budget`
            : "API key budget";
          windows.push({
            label: periodLabel,
            usedPercent:
              keyBudget.limit === 0 ? 100 : Math.min(100, (keyBudget.used / keyBudget.limit) * 100),
          });
        }
        const billing: NonNullable<ProviderUsageSnapshot["billing"]> = [];
        if (totalCredits !== undefined && totalUsage !== undefined) {
          billing.push({
            type: "balance",
            label: "Account balance",
            amount: totalCredits - totalUsage,
            unit: "USD",
          });
          billing.push({ type: "spend", label: "Account usage", amount: totalUsage, unit: "USD" });
        }
        if (keyBudget) {
          billing.push({
            type: "budget",
            label: "API key budget",
            used: keyBudget.used,
            limit: keyBudget.limit,
            unit: "USD",
            ...(keyBudget.period ? { period: keyBudget.period } : {}),
          });
        } else if (keyUsage !== undefined) {
          billing.push({ type: "spend", label: "API key usage", amount: keyUsage, unit: "USD" });
        }
        const keyLabel = typeof key?.label === "string" ? key.label.trim() : "";
        const periodUsage: [string, number | undefined][] = [
          ["today", parseProviderUsageNonNegativeNumber(key?.usage_daily)],
          ["this week", parseProviderUsageNonNegativeNumber(key?.usage_weekly)],
          ["this month", parseProviderUsageNonNegativeNumber(key?.usage_monthly)],
        ];
        const summary = periodUsage
          .flatMap(([period, amount]) =>
            amount === undefined ? [] : [`$${amount.toFixed(2)} ${period}`],
          )
          .join(" · ");
        return {
          provider: "openrouter",
          displayName: "OpenRouter",
          windows,
          ...(billing.length > 0 ? { billing } : {}),
          ...(summary ? { summary } : {}),
          ...(keyLabel ? { plan: keyLabel } : {}),
        };
      },
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
