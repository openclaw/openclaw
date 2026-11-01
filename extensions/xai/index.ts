import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { parseDateStringTimestampMs } from "openclaw/plugin-sdk/number-runtime";
import type {
  OpenClawPluginToolContext,
  ProviderFailoverErrorContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { isProviderApiKeyConfiguredAsync } from "openclaw/plugin-sdk/provider-auth";
import { runLiveProviderCatalog } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { defaultToolStreamExtraParams } from "openclaw/plugin-sdk/provider-stream-shared";
import {
  buildUsageHttpErrorSnapshot,
  clampPercent,
  fetchJson,
  type ProviderUsageBilling,
  type UsageWindow,
} from "openclaw/plugin-sdk/provider-usage";
import { jsonResult } from "openclaw/plugin-sdk/provider-web-search";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  buildMissingCodeExecutionApiKeyPayload,
  createCodeExecutionToolDefinition,
} from "./code-execution-tool-shared.js";
import {
  createLazyXaiImageGenerationProvider,
  createLazyXaiMediaUnderstandingProvider,
  createLazyXaiRealtimeTranscriptionProvider,
  createLazyXaiRealtimeVoiceProvider,
  createLazyXaiSpeechProvider,
  createLazyXaiVideoGenerationProvider,
} from "./lazy-capability-provider-factories.js";
import { normalizeNativeXaiModelId } from "./model-compat.js";
import { applyXaiConfig, XAI_DEFAULT_MODEL_REF } from "./onboard.js";
import {
  buildLiveXaiOAuthProvider,
  buildLiveXaiProvider,
  buildXaiProvider,
  isXaiGrokProxyBaseUrl,
} from "./provider-catalog.js";
import { isXaiProviderId } from "./provider-id.js";
import { isModernXaiModel, resolveXaiForwardCompatModel } from "./provider-models.js";
import { resolveThinkingProfile } from "./provider-policy-api.js";
import { resolveXaiTransport } from "./provider-routing.js";
import { applyXaiRuntimeModelCompat } from "./runtime-model-compat.js";
import {
  readPluginCodeExecutionConfig,
  resolveCodeExecutionEnabled,
} from "./src/code-execution-config.js";
import {
  isXaiToolEnabled,
  resolveFallbackXaiAuth,
  type XaiToolAuthContext,
} from "./src/tool-auth-shared.js";
import { resolveEffectiveXSearchConfig } from "./src/x-search-config.js";
import { wrapXaiProviderStream } from "./stream.js";
import { createXaiWebSearchProvider } from "./web-search.js";
import {
  buildMissingXSearchApiKeyPayload,
  createXSearchToolDefinition,
} from "./x-search-tool-shared.js";
import {
  createXaiDeviceCodeAuthMethod,
  createXaiOAuthAuthMethod,
  refreshXaiOAuthCredential,
} from "./xai-oauth-entry.js";

const SUPERGROK_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const SUPERGROK_CLIENT_MODE = "cli";
const SUPERGROK_CLIENT_VERSION = "1.0.4";
const MAX_PLAN_CHARS = 128;
const MAX_EXACT_INTEGER = 9_007_199_254_740_991;

type BillingConfig = Record<string, unknown>;

function parseCentValue(value: unknown): number | undefined {
  const raw = asOptionalRecord(value)?.val;
  if (raw === undefined || raw === null) {
    return 0;
  }
  if (typeof raw === "number" && Number.isInteger(raw)) {
    return raw;
  }
  if (typeof raw === "string" && /^-?\d+$/.test(raw.trim())) {
    return Number.parseInt(raw.trim(), 10);
  }
  return undefined;
}

function parseMoneyValue(value: unknown): number | undefined {
  const cents = parseCentValue(value);
  if (cents === undefined || cents < 0 || cents > MAX_EXACT_INTEGER) {
    return undefined;
  }
  return cents / 100;
}

function parsePlan(value: unknown): string | undefined {
  const plan = normalizeOptionalString(value);
  if (!plan || plan.length > MAX_PLAN_CHARS || hasControlCharacter(plan)) {
    return undefined;
  }
  return plan;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) < 32) {
      return true;
    }
  }
  return false;
}

function parsePercent(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return clampPercent(value);
}

function readCurrentPeriod(config: BillingConfig) {
  return asOptionalRecord(config["currentPeriod"] ?? config["current_period"]);
}

function readPeriodBoundMs(
  config: BillingConfig,
  currentPeriod: Record<string, unknown> | undefined,
  bound: "start" | "end",
): number | undefined {
  const billingKey = bound === "start" ? "billingPeriodStart" : "billingPeriodEnd";
  const billingSnakeKey = bound === "start" ? "billing_period_start" : "billing_period_end";
  return parseDateStringTimestampMs(
    currentPeriod?.[bound] ?? config[billingKey] ?? config[billingSnakeKey],
  );
}

function hasRecognizedUsagePeriod(config: BillingConfig): boolean {
  const currentPeriod = readCurrentPeriod(config);
  const periodType = normalizeOptionalString(currentPeriod?.type) ?? "";
  if (!periodType.endsWith("WEEKLY") && !periodType.endsWith("MONTHLY")) {
    return false;
  }
  return (
    readPeriodBoundMs(config, currentPeriod, "start") !== undefined ||
    readPeriodBoundMs(config, currentPeriod, "end") !== undefined
  );
}

function resolveUsageWindow(config: BillingConfig): UsageWindow | undefined {
  const currentPeriod = readCurrentPeriod(config);
  const explicitPercent = parsePercent(
    config["creditUsagePercent"] ?? config["credit_usage_percent"],
  );
  const used = parseCentValue(config["used"]);
  const monthlyLimit = parseCentValue(config["monthlyLimit"] ?? config["monthly_limit"]);
  const legacyPercent =
    used !== undefined && monthlyLimit !== undefined && monthlyLimit > 0 && used >= 0
      ? parsePercent((used / monthlyLimit) * 100)
      : undefined;
  const percent = explicitPercent ?? legacyPercent;
  if (percent === undefined) {
    return undefined;
  }

  const periodType = normalizeOptionalString(currentPeriod?.type) ?? "";
  const label = periodType.endsWith("WEEKLY")
    ? "Weekly"
    : periodType.endsWith("MONTHLY") ||
        monthlyLimit !== undefined ||
        config["billingPeriodEnd"] !== undefined ||
        config["billing_period_end"] !== undefined
      ? "Monthly"
      : "Usage";
  const resetAt = readPeriodBoundMs(config, currentPeriod, "end");
  return {
    label,
    usedPercent: percent,
    ...(resetAt !== undefined ? { resetAt } : {}),
  };
}

function resolveBilling(config: BillingConfig): ProviderUsageBilling[] | undefined {
  const prepaid = parseMoneyValue(config["prepaidBalance"] ?? config["prepaid_balance"]);
  if (prepaid === undefined) {
    return undefined;
  }
  return [
    {
      type: "balance",
      label: "Prepaid balance",
      amount: prepaid,
      unit: "USD",
    },
  ];
}

const PROVIDER_ID = "xai";

const XAI_CREDIT_OR_SPENDING_LIMIT_RE =
  /\b(?:used all available credits|run out of credits|monthly spending limit|purchase more credits|raise your spending limit|need a Grok subscription)\b/i;
const XAI_RATE_LIMIT_RE = /\b(?:rate limit exceeded|too many requests)\b/i;
const XAI_PROVIDER_INTERNAL_ERROR_RE = /\binternal error during token generation\b/i;

const loadCodeExecutionModule = createLazyRuntimeModule(() => import("./code-execution.js"));

const loadXSearchModule = createLazyRuntimeModule(() => import("./x-search.js"));

function classifyXaiFailoverReason({
  errorMessage,
  status,
  code,
  errorType,
}: ProviderFailoverErrorContext) {
  if (XAI_CREDIT_OR_SPENDING_LIMIT_RE.test(errorMessage)) {
    return "billing" as const;
  }
  if (XAI_RATE_LIMIT_RE.test(errorMessage)) {
    return "rate_limit" as const;
  }
  if (
    status === undefined &&
    code === undefined &&
    errorType === undefined &&
    XAI_PROVIDER_INTERNAL_ERROR_RE.test(errorMessage)
  ) {
    return "server_error" as const;
  }
  return undefined;
}

function isCodeExecutionEnabled(
  config: OpenClawConfig | undefined,
  auth?: XaiToolAuthContext,
): boolean {
  return resolveCodeExecutionEnabled({
    sourceConfig: config,
    runtimeConfig: config,
    config: readPluginCodeExecutionConfig(config),
    auth,
  });
}

function isXSearchEnabled(config: OpenClawConfig | undefined, auth?: XaiToolAuthContext): boolean {
  const resolved = resolveEffectiveXSearchConfig(config);
  if (resolved?.enabled === false) {
    return false;
  }
  return isXaiToolEnabled({ sourceConfig: config, auth });
}

function shouldExposeXaiBilledTool(params: {
  activeProvider?: string;
  enabled?: unknown;
}): boolean {
  const activeProvider = params.activeProvider?.trim();
  if (!activeProvider || params.enabled === false) {
    return false;
  }
  // Cross-provider billing requires explicit consent; xAI models retain the
  // credential-backed default. Unknown providers fail closed.
  return isXaiProviderId(activeProvider) || params.enabled === true;
}

function canExposeXaiBilledTool(
  ctx: OpenClawPluginToolContext,
  readConfig: (config: OpenClawConfig | undefined) => { enabled?: unknown } | undefined,
  isEnabled: (config: OpenClawConfig | undefined, auth?: XaiToolAuthContext) => boolean,
): boolean {
  const effectiveConfig = ctx.runtimeConfig ?? ctx.config;
  const enabled = readConfig(effectiveConfig)?.enabled;
  return (
    shouldExposeXaiBilledTool({ activeProvider: ctx.activeModel?.provider, enabled }) &&
    isEnabled(effectiveConfig, ctx)
  );
}

function createLazyCodeExecutionTool(ctx: OpenClawPluginToolContext) {
  if (!canExposeXaiBilledTool(ctx, readPluginCodeExecutionConfig, isCodeExecutionEnabled)) {
    return null;
  }

  return createCodeExecutionToolDefinition(
    async (toolCallId: string, args: Record<string, unknown>) => {
      const { createCodeExecutionTool } = await loadCodeExecutionModule();
      const tool = createCodeExecutionTool({
        config: ctx.config,
        runtimeConfig: ctx.runtimeConfig ?? null,
        auth: ctx,
      });
      if (!tool) {
        return jsonResult(buildMissingCodeExecutionApiKeyPayload());
      }
      return await tool.execute(toolCallId, args);
    },
  );
}

function createLazyXSearchTool(ctx: OpenClawPluginToolContext) {
  if (!canExposeXaiBilledTool(ctx, resolveEffectiveXSearchConfig, isXSearchEnabled)) {
    return null;
  }

  return createXSearchToolDefinition(async (toolCallId, args, signal) => {
    signal?.throwIfAborted();
    const { createXSearchTool } = await loadXSearchModule();
    signal?.throwIfAborted();
    const tool = createXSearchTool({
      config: ctx.config as never,
      runtimeConfig: (ctx.runtimeConfig as never) ?? null,
      auth: ctx,
    });
    if (!tool) {
      return jsonResult(buildMissingXSearchApiKeyPayload());
    }
    return await tool.execute(toolCallId, args, signal);
  });
}

export default defineSingleProviderPluginEntry({
  id: "xai",
  name: "xAI Plugin",
  description: "Bundled xAI plugin",
  provider: (pluginApi) => ({
    label: "xAI",
    aliases: ["x-ai"],
    docsPath: "/providers/xai",
    auth: [
      {
        methodId: "api-key",
        label: "xAI API key",
        hint: "API key",
        optionKey: "xaiApiKey",
        flagName: "--xai-api-key",
        envVar: "XAI_API_KEY",
        promptMessage: "Enter xAI API key",
        defaultModel: XAI_DEFAULT_MODEL_REF,
        preserveExistingPrimary: true,
        applyConfig: (cfg) => applyXaiConfig(cfg),
        wizard: {
          groupLabel: "xAI (Grok)",
        },
      },
    ],
    extraAuth: [createXaiOAuthAuthMethod(), createXaiDeviceCodeAuthMethod()],
    catalog: {
      order: "simple",
      run: async (ctx) => {
        const auth = ctx.resolveProviderAuth(PROVIDER_ID);
        if (auth.preparationFailed) {
          return null;
        }
        const { resolveApiKeyForProvider } =
          await import("openclaw/plugin-sdk/provider-auth-runtime");
        const grokProxy = isXaiGrokProxyBaseUrl(
          ctx.config.models?.providers?.[PROVIDER_ID]?.baseUrl,
        );
        // Static token material can already be ready in a cold command or worker.
        const resolvedAuth =
          auth.mode === "token" && grokProxy && auth.discoveryApiKey
            ? { ...auth, apiKey: auth.discoveryApiKey }
            : await resolveApiKeyForProvider({
                provider: PROVIDER_ID,
                cfg: ctx.config,
                ...(ctx.agentDir ? { agentDir: ctx.agentDir } : {}),
                ...(ctx.workspaceDir ? { workspaceDir: ctx.workspaceDir } : {}),
                ...(auth.profileId ? { profileId: auth.profileId, lockedProfile: true } : {}),
                // Prepared direct auth must not reopen failed profile candidates.
                ...(!auth.profileId && auth.mode !== "none"
                  ? { allowAuthProfileFallback: false }
                  : {}),
              }).catch(() => undefined);
        // Static token storage does not distinguish subscription tokens from Console API tokens.
        const subscriptionToken =
          (resolvedAuth?.mode === "token" || auth.mode === "token") && grokProxy;
        if (subscriptionToken && (!resolvedAuth?.apiKey || resolvedAuth.mode !== "token")) {
          return {
            providers: {},
            outcomes: [{ provider: PROVIDER_ID, profileId: auth.profileId, status: "unavailable" }],
          };
        }
        const selectedAuth =
          resolvedAuth?.apiKey && (resolvedAuth.mode === "oauth" || subscriptionToken)
            ? { ...resolvedAuth, oauth: true }
            : { ...(auth.apiKey ? auth : ctx.resolveProviderApiKey(PROVIDER_ID)), oauth: false };
        if (!selectedAuth.apiKey) {
          return null;
        }
        const apiKey = selectedAuth.apiKey;
        return await runLiveProviderCatalog({
          providerId: PROVIDER_ID,
          profileId: selectedAuth.profileId,
          run: async () => ({
            provider: selectedAuth.oauth
              ? await buildLiveXaiOAuthProvider({
                  discoveryApiKey: apiKey,
                  authMode: selectedAuth.mode === "token" ? "token" : "oauth",
                })
              : await buildLiveXaiProvider(selectedAuth),
          }),
        });
      },
      staticRun: async (ctx) => {
        const auth = ctx.resolveProviderAuth(PROVIDER_ID);
        const authMode =
          auth.mode === "oauth"
            ? "oauth"
            : auth.mode === "token" &&
                isXaiGrokProxyBaseUrl(ctx.config.models?.providers?.[PROVIDER_ID]?.baseUrl)
              ? "token"
              : undefined;
        return { provider: buildXaiProvider("openai-responses", authMode) };
      },
    },
    ...buildProviderReplayFamilyHooks({ family: "openai-compatible" }),
    prepareExtraParams: (ctx) => defaultToolStreamExtraParams(ctx.extraParams),
    wrapStreamFn: (ctx) =>
      wrapXaiProviderStream(ctx, {
        clientVersion: pluginApi.runtime.version,
      }),
    // Provider-specific fallback auth stays owned by the xAI plugin so core
    // auth/discovery code can consume it generically without parsing xAI's
    // private config layout. Callers may receive a real key from the active
    // runtime snapshot or a non-secret SecretRef marker from source config.
    resolveSyntheticAuth: ({ config }) => {
      const fallbackAuth = resolveFallbackXaiAuth(config);
      if (!fallbackAuth) {
        return undefined;
      }
      return {
        apiKey: fallbackAuth.apiKey,
        source: fallbackAuth.source,
        mode: "api-key" as const,
      };
    },
    normalizeResolvedModel: ({ model }) => applyXaiRuntimeModelCompat(model),
    normalizeTransport: ({ provider, api, baseUrl }) =>
      resolveXaiTransport({ provider, api, baseUrl }),
    normalizeModelId: ({ modelId }) => normalizeNativeXaiModelId(modelId),
    resolveDynamicModel: (ctx) => resolveXaiForwardCompatModel({ providerId: PROVIDER_ID, ctx }),
    refreshOAuth: refreshXaiOAuthCredential,
    resolveUsageAuth: async (ctx) => {
      const oauth = await ctx.resolveOAuthToken();
      return oauth ? oauth : { handled: true };
    },
    fetchUsageSnapshot: async (ctx) => {
      const response = await fetchJson(
        SUPERGROK_BILLING_URL,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${ctx.token}`,
            Accept: "application/json",
            "x-grok-client-mode": SUPERGROK_CLIENT_MODE,
            "x-grok-client-version": SUPERGROK_CLIENT_VERSION,
          },
        },
        ctx.timeoutMs,
        ctx.fetchFn,
      );
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return buildUsageHttpErrorSnapshot({
          provider: PROVIDER_ID,
          status: response.status,
          tokenExpiredStatuses: [401, 403],
        });
      }

      try {
        const data = await readProviderJsonResponse<unknown>(response, "xai-usage");
        const payload = asOptionalRecord(data);
        const config = asOptionalRecord(payload?.["config"]);
        if (!config) {
          return {
            provider: PROVIDER_ID,
            displayName: "SuperGrok",
            windows: [],
            error: "Malformed billing response",
          };
        }

        const window = resolveUsageWindow(config);
        const billing = resolveBilling(config);
        const plan =
          parsePlan(payload?.["subscription_tier"] ?? payload?.["subscriptionTier"]) ?? "SuperGrok";
        // xAI omits default-zero included-usage scalars on valid weekly/monthly
        // billing responses. Do not invent a percent, and do not read on-demand
        // pay-as-you-go counters as SuperGrok subscription quota.
        if (
          window ||
          ((config["creditUsagePercent"] ?? config["credit_usage_percent"]) === undefined &&
            hasRecognizedUsagePeriod(config))
        ) {
          return {
            provider: PROVIDER_ID,
            displayName: "SuperGrok",
            windows: window ? [window] : [],
            billing,
            plan,
            ...(window ? {} : { summary: "Included usage omitted" }),
          };
        }

        return {
          provider: PROVIDER_ID,
          displayName: "SuperGrok",
          windows: [],
          error: "No usage data",
        };
      } catch {
        return {
          provider: PROVIDER_ID,
          displayName: "SuperGrok",
          windows: [],
          error: "Malformed billing response",
        };
      }
    },
    resolveThinkingProfile,
    isModernModelRef: ({ modelId }) => isModernXaiModel(modelId),
    classifyFailoverReason: classifyXaiFailoverReason,
  }),
  register(api) {
    api.registerWebSearchProvider(createXaiWebSearchProvider());
    api.registerMediaUnderstandingProvider(createLazyXaiMediaUnderstandingProvider());
    api.registerVideoGenerationProvider(
      createLazyXaiVideoGenerationProvider({ isProviderApiKeyConfiguredAsync }),
    );
    api.registerImageGenerationProvider(createLazyXaiImageGenerationProvider());
    api.registerSpeechProvider(createLazyXaiSpeechProvider);
    api.registerRealtimeTranscriptionProvider(createLazyXaiRealtimeTranscriptionProvider);
    api.registerRealtimeVoiceProvider(createLazyXaiRealtimeVoiceProvider);
    api.registerTool((ctx) => createLazyCodeExecutionTool(ctx), { name: "code_execution" });
    api.registerTool((ctx) => createLazyXSearchTool(ctx), { name: "x_search" });
  },
});
