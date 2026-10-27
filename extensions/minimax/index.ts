import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { streamSimple } from "openclaw/plugin-sdk/llm";
import {
  definePluginEntry,
  type OpenClawConfig,
  type ProviderAuthContext,
  type ProviderAuthResult,
  type ProviderCatalogContext,
  type ProviderCatalogResult,
  type ProviderResolveDynamicModelContext,
  type ProviderRuntimeModel,
  type ProviderWrapStreamFnContext,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  MINIMAX_OAUTH_MARKER,
  buildOauthProviderAuthResult,
  isNonSecretApiKeyMarker,
} from "openclaw/plugin-sdk/provider-auth";
import { buildOpenAICompatibleLiveProviderCatalog } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-entry";
import {
  buildProviderReplayFamilyHooks,
  normalizeModelCompat,
} from "openclaw/plugin-sdk/provider-model-shared";
import { buildProviderStreamFamilyHooks } from "openclaw/plugin-sdk/provider-stream-family";
import { streamWithPayloadPatch } from "openclaw/plugin-sdk/provider-stream-shared";
import { fetchMinimaxUsage } from "openclaw/plugin-sdk/provider-usage";
import { normalizeOptionalString, isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  isMiniMaxModernModelId,
  MINIMAX_DEFAULT_MODEL_ID,
  MINIMAX_TEXT_MODEL_ORDER,
} from "./api.js";
import { buildMinimaxImageGenerationProvider } from "./image-generation-provider.js";
import {
  buildMinimaxApiModelDefinition,
  MINIMAX_API_BASE_URL,
  MINIMAX_CN_API_BASE_URL,
} from "./model-definitions.js";
import { buildMinimaxMusicGenerationProvider } from "./music-generation-provider.js";
import type { MiniMaxRegion } from "./oauth.js";
import { applyMinimaxApiConfig, applyMinimaxApiConfigCn } from "./onboard.js";
import {
  buildMinimaxModelDiscovery,
  buildMinimaxProvider,
  resolveMinimaxCatalogBaseUrl,
} from "./provider-catalog.js";
import {
  createMinimaxPortalProvider,
  createMinimaxProvider,
  minimaxAuthMethodMetadata,
} from "./provider-contract-api.js";
import { buildMinimaxSpeechProvider } from "./speech-provider-factory.js";
import { createMiniMaxWebSearchProvider } from "./src/minimax-web-search-provider.js";
import {
  isMinimaxM31ModelId,
  MINIMAX_M31_MODEL_ID,
  MINIMAX_M31_THINKING_LEVELS,
} from "./thinking.js";
import { buildMinimaxVideoGenerationProvider } from "./video-generation-provider.js";

const FAST_MODE_HOOKS = buildProviderStreamFamilyHooks("minimax-fast-mode");
const M31_MAX_TOKENS = buildMinimaxApiModelDefinition(MINIMAX_M31_MODEL_ID).maxTokens;

function wrapMinimaxProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn {
  const underlying = FAST_MODE_HOOKS.wrapStreamFn?.(ctx) ?? ctx.streamFn ?? streamSimple;
  return (model, context, options) => {
    if ((ctx.sourceApi ?? model.api) !== "anthropic-messages" || !isMinimaxM31ModelId(model.id)) {
      return underlying(model, context, options);
    }
    const requested = options?.reasoning ?? ctx.thinkingLevel;
    // Runtime streams cap reasoning at "high"; keep the session's xhigh/max for M3.1.
    const thinkingLevel =
      requested === "high" && (ctx.thinkingLevel === "xhigh" || ctx.thinkingLevel === "max")
        ? ctx.thinkingLevel
        : requested;
    const effort = MINIMAX_M31_THINKING_LEVELS.find((level) => level === thinkingLevel) ?? "max";
    // The Anthropic client uses a manual budget for non-Claude models. Give that
    // calculation room to retain signed history; the payload keeps the real cap below.
    const resolvedModel =
      model.maxTokens < M31_MAX_TOKENS ? { ...model, maxTokens: M31_MAX_TOKENS } : model;
    // Resolve mandatory thinking before the client converts prior assistant messages.
    return streamWithPayloadPatch(
      underlying,
      resolvedModel,
      context,
      { ...options, reasoning: effort, thinkingBudgets: undefined },
      (payload) => {
        // M3.1 requires adaptive thinking and uses effort instead of a token budget.
        payload.thinking = { type: "adaptive" };
        payload.output_config = {
          ...(isRecord(payload.output_config) ? payload.output_config : {}),
          effort,
        };
        const maxTokens = options?.maxTokens ?? payload.max_tokens;
        if (typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0) {
          payload.max_tokens = Math.min(Math.floor(maxTokens), model.maxTokens);
        }
      },
    );
  };
}

const API_PROVIDER_ID = "minimax";
const PORTAL_PROVIDER_ID = "minimax-portal";
const MINIMAX_USAGE_ENV_VAR_KEYS = [
  "MINIMAX_OAUTH_TOKEN",
  "MINIMAX_CODE_PLAN_KEY",
  "MINIMAX_CODING_API_KEY",
  "MINIMAX_API_KEY",
] as const;
const MINIMAX_PROVIDER_HOOKS = {
  ...buildProviderReplayFamilyHooks({
    family: "hybrid-anthropic-openai",
    anthropicModelDropThinkingBlocks: true,
  }),
  wrapStreamFn: wrapMinimaxProviderStream,
  wrapSimpleCompletionStreamFn: wrapMinimaxProviderStream,
  resolveReasoningOutputMode: () => "native" as const,
  isModernModelRef: ({ modelId }: { modelId: string }) => isMiniMaxModernModelId(modelId),
};

function getProviderBaseUrl(cfg: OpenClawConfig, providerId: string): string | undefined {
  return normalizeOptionalString(cfg.models?.providers?.[providerId]?.baseUrl);
}

function resolveMinimaxUsageBaseUrl(cfg: OpenClawConfig): string | undefined {
  return getProviderBaseUrl(cfg, PORTAL_PROVIDER_ID) ?? getProviderBaseUrl(cfg, API_PROVIDER_ID);
}

function resolveMinimaxDynamicModel(params: {
  providerId: string;
  ctx: ProviderResolveDynamicModelContext;
}): ProviderRuntimeModel | undefined {
  const normalizedModelId = params.ctx.modelId.trim().toLowerCase();
  const catalogModelId = MINIMAX_TEXT_MODEL_ORDER.find(
    (id) => id.toLowerCase() === normalizedModelId,
  );
  if (!catalogModelId) {
    return undefined;
  }
  return normalizeModelCompat({
    ...buildMinimaxApiModelDefinition(catalogModelId),
    provider: params.providerId,
    api: "anthropic-messages",
    baseUrl:
      normalizeOptionalString(params.ctx.providerConfig?.baseUrl) ?? resolveMinimaxCatalogBaseUrl(),
  });
}

async function resolveApiCatalog(ctx: ProviderCatalogContext) {
  const auth = ctx.resolveProviderApiKey(API_PROVIDER_ID);
  if (!auth.apiKey) {
    return null;
  }
  const defaults = buildMinimaxProvider(ctx.env);
  const providerConfig = {
    ...defaults,
    baseUrl: getProviderBaseUrl(ctx.config, API_PROVIDER_ID) ?? defaults.baseUrl,
    api: ctx.config.models?.providers?.[API_PROVIDER_ID]?.api ?? defaults.api,
  };
  return await buildOpenAICompatibleLiveProviderCatalog({
    discoveryMode: "strict",
    providerId: API_PROVIDER_ID,
    providerConfig,
    apiKey: auth.apiKey,
    discoveryApiKey: auth.discoveryApiKey,
    profileId: auth.profileId,
    modelDiscovery: buildMinimaxModelDiscovery(providerConfig),
  });
}

async function resolvePortalCatalog(ctx: ProviderCatalogContext): Promise<ProviderCatalogResult> {
  const explicitProvider = ctx.config.models?.providers?.[PORTAL_PROVIDER_ID];
  const apiKeyAuth = ctx.resolveProviderApiKey(PORTAL_PROVIDER_ID);
  const profileAuth = ctx.resolveProviderAuth(PORTAL_PROVIDER_ID, {
    oauthMarker: MINIMAX_OAUTH_MARKER,
  });
  const explicitApiKey = normalizeOptionalString(explicitProvider?.apiKey);
  let auth: ReturnType<ProviderCatalogContext["resolveProviderApiKey" | "resolveProviderAuth"]> =
    apiKeyAuth.apiKey !== undefined
      ? apiKeyAuth
      : explicitApiKey
        ? { apiKey: explicitApiKey }
        : profileAuth;
  const { apiKey } = auth;
  if (!apiKey) {
    return null;
  }
  if (!normalizeOptionalString(auth.discoveryApiKey) && isNonSecretApiKeyMarker(apiKey)) {
    // Legacy callbacks may omit material; only matching selection facts can complete it.
    if (
      auth.profileId &&
      profileAuth.source === "profile" &&
      auth.profileId === profileAuth.profileId &&
      apiKey === profileAuth.apiKey &&
      (auth.mode === undefined || auth.mode === profileAuth.mode)
    ) {
      auth = profileAuth;
    }
    if (!normalizeOptionalString(auth.discoveryApiKey)) {
      return {
        providers: {},
        outcomes: [
          { provider: PORTAL_PROVIDER_ID, profileId: auth.profileId, status: "unavailable" },
        ],
      };
    }
  }
  const usesPortalBearerAuth =
    apiKeyAuth.apiKey === "MINIMAX_OAUTH_TOKEN" ||
    (apiKeyAuth.apiKey && apiKeyAuth.mode
      ? apiKeyAuth.mode === "token" || apiKeyAuth.mode === "oauth"
      : (profileAuth.mode === "token" && profileAuth.apiKey === apiKey) ||
        (!apiKeyAuth.apiKey && !explicitApiKey && profileAuth.mode === "oauth"));

  const explicitBaseUrl = normalizeOptionalString(explicitProvider?.baseUrl);

  const providerConfig = {
    ...buildMinimaxProvider(ctx.env),
    ...(explicitBaseUrl ? { baseUrl: explicitBaseUrl } : {}),
    apiKey,
  };
  return await buildOpenAICompatibleLiveProviderCatalog({
    discoveryMode: "strict",
    providerId: PORTAL_PROVIDER_ID,
    providerConfig,
    apiKey,
    discoveryApiKey: auth.discoveryApiKey,
    profileId: auth.profileId,
    modelDiscovery: buildMinimaxModelDiscovery(
      providerConfig,
      usesPortalBearerAuth ? "oauth" : "api_key",
    ),
  });
}

function createOAuthHandler(region: MiniMaxRegion) {
  const defaultBaseUrl = region === "cn" ? MINIMAX_CN_API_BASE_URL : MINIMAX_API_BASE_URL;
  const regionLabel = region === "cn" ? "CN" : "Global";

  return async (ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
    const progress = ctx.prompter.progress(`Starting MiniMax OAuth (${regionLabel})…`);
    try {
      const { loginMiniMaxPortalOAuth } = await import("./oauth.runtime.js");
      const result = await loginMiniMaxPortalOAuth({
        openUrl: ctx.openUrl,
        note: (message, title) => ctx.prompter.note(message, title),
        deviceCode: ctx.prompter.deviceCode,
        progress,
        region,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        ...(ctx.assertCurrent ? { assertCurrent: ctx.assertCurrent } : {}),
      });

      progress.stop("MiniMax OAuth complete");

      if (result.notification_message) {
        await ctx.prompter.note(result.notification_message, "MiniMax OAuth");
      }

      const baseUrl = result.resourceUrl || defaultBaseUrl;

      return buildOauthProviderAuthResult({
        providerId: PORTAL_PROVIDER_ID,
        defaultModel: `${PORTAL_PROVIDER_ID}/${MINIMAX_DEFAULT_MODEL_ID}`,
        access: result.access,
        refresh: result.refresh,
        expires: result.expires,
        credentialExtra: { authFlow: "device-code", tokenEndpoint: result.tokenEndpoint },
        configPatch: {
          models: {
            providers: {
              [PORTAL_PROVIDER_ID]: {
                baseUrl,
                api: "anthropic-messages",
                authHeader: true,
                models: [],
              },
            },
          },
          agents: {
            defaults: {
              models: {
                [`${PORTAL_PROVIDER_ID}/MiniMax-M3`]: { alias: "minimax-m3" },
                [`${PORTAL_PROVIDER_ID}/MiniMax-M2.7`]: { alias: "minimax-m2.7" },
                [`${PORTAL_PROVIDER_ID}/MiniMax-M2.7-highspeed`]: {
                  alias: "minimax-m2.7-highspeed",
                },
              },
            },
          },
        },
        notes: [
          "MiniMax OAuth tokens auto-refresh. Re-run login if refresh fails or access is revoked.",
          `Base URL defaults to ${defaultBaseUrl}. Override models.providers.${PORTAL_PROVIDER_ID}.baseUrl if needed.`,
          ...(result.notification_message ? [result.notification_message] : []),
        ],
      });
    } catch (err) {
      const errorMsg = formatErrorMessage(err);
      progress.stop(`MiniMax OAuth failed: ${errorMsg}`);
      await ctx.prompter.note(
        "If OAuth fails, verify your MiniMax account has portal access and try again.",
        "MiniMax OAuth",
      );
      throw err;
    }
  };
}

function createMinimaxApiKeyMethod(region: MiniMaxRegion) {
  const metadata = minimaxAuthMethodMetadata(region, "api_key");
  const isCn = region === "cn";
  return createProviderApiKeyAuthMethod({
    providerId: API_PROVIDER_ID,
    methodId: metadata.id,
    label: metadata.label,
    hint: metadata.hint,
    optionKey: "minimaxApiKey",
    flagName: "--minimax-api-key",
    envVar: "MINIMAX_API_KEY",
    promptMessage: isCn
      ? "Enter MiniMax CN API key (sk-api- or sk-cp-)\nhttps://platform.minimaxi.com/user-center/basic-information/interface-key"
      : "Enter MiniMax API key (sk-api- or sk-cp-)\nhttps://platform.minimax.io/user-center/basic-information/interface-key",
    profileId: isCn ? "minimax:cn" : "minimax:global",
    allowProfile: false,
    defaultModel: `${API_PROVIDER_ID}/${MINIMAX_DEFAULT_MODEL_ID}`,
    expectedProviders: isCn ? ["minimax", "minimax-cn"] : ["minimax"],
    applyConfig: (cfg) => (isCn ? applyMinimaxApiConfigCn(cfg) : applyMinimaxApiConfig(cfg)),
    wizard: metadata.wizard,
  });
}

function createMinimaxOAuthMethod(region: MiniMaxRegion) {
  return {
    ...minimaxAuthMethodMetadata(region, "device_code"),
    run: createOAuthHandler(region),
  };
}

export default definePluginEntry({
  id: "minimax",
  name: "MiniMax",
  description: "Bundled MiniMax API-key and OAuth provider plugin",
  register(api) {
    api.registerProvider({
      ...createMinimaxProvider(),
      auth: [createMinimaxApiKeyMethod("global"), createMinimaxApiKeyMethod("cn")],
      catalog: {
        order: "simple",
        run: resolveApiCatalog,
      },
      staticCatalog: {
        order: "simple",
        run: async (ctx) => ({ providers: { [API_PROVIDER_ID]: buildMinimaxProvider(ctx.env) } }),
      },
      resolveUsageAuth: async (ctx) => {
        const portalOauth = await ctx.resolveOAuthToken({ provider: PORTAL_PROVIDER_ID });
        if (portalOauth) {
          return portalOauth;
        }
        const apiKey = (
          await ctx.resolveApiKeyCandidatesFromConfigAndStore?.({
            providerIds: [API_PROVIDER_ID, PORTAL_PROVIDER_ID],
            envDirect: MINIMAX_USAGE_ENV_VAR_KEYS.map((name) => ctx.env[name]),
          })
        )?.[0];
        return apiKey ? { token: apiKey } : null;
      },
      ...MINIMAX_PROVIDER_HOOKS,
      resolveDynamicModel: (ctx) =>
        resolveMinimaxDynamicModel({ providerId: API_PROVIDER_ID, ctx }),
      fetchUsageSnapshot: async (ctx) =>
        await fetchMinimaxUsage(ctx.token, ctx.timeoutMs, ctx.fetchFn, {
          baseUrl: resolveMinimaxUsageBaseUrl(ctx.config),
        }),
    });
    api.registerProvider({
      ...createMinimaxPortalProvider(),
      catalog: {
        run: resolvePortalCatalog,
      },
      staticCatalog: {
        run: async (ctx) => ({
          providers: { [PORTAL_PROVIDER_ID]: buildMinimaxProvider(ctx.env) },
        }),
      },
      auth: [createMinimaxOAuthMethod("global"), createMinimaxOAuthMethod("cn")],
      refreshOAuth: async (credential, config) => {
        const { refreshMiniMaxPortalOAuthCredential } = await import("./oauth.runtime.js");
        return await refreshMiniMaxPortalOAuthCredential(
          credential,
          config === undefined
            ? normalizeOptionalString(
                api.runtime.config.current().models?.providers?.[PORTAL_PROVIDER_ID]?.baseUrl,
              )
            : getProviderBaseUrl(config, PORTAL_PROVIDER_ID),
        );
      },
      ...MINIMAX_PROVIDER_HOOKS,
      resolveDynamicModel: (ctx) =>
        resolveMinimaxDynamicModel({ providerId: PORTAL_PROVIDER_ID, ctx }),
    });
    api.registerMediaUnderstandingProvider({
      id: "minimax",
      capabilities: ["image"],
      defaultModels: { image: "MiniMax-VL-01" },
      documentModels: { pdf: { textExtraction: "MiniMax-M2.7", image: false } },
      autoPriority: { image: 40 },
      describeImage: undefined,
      describeImages: undefined,
    });
    api.registerMediaUnderstandingProvider({
      id: "minimax-portal",
      capabilities: ["image"],
      defaultModels: { image: "MiniMax-VL-01" },
      documentModels: { pdf: { textExtraction: "MiniMax-M2.7", image: false } },
      autoPriority: { image: 50 },
      describeImage: undefined,
      describeImages: undefined,
    });
    api.registerImageGenerationProvider(buildMinimaxImageGenerationProvider());
    api.registerImageGenerationProvider(buildMinimaxImageGenerationProvider("minimax-portal"));
    api.registerMusicGenerationProvider(buildMinimaxMusicGenerationProvider());
    api.registerMusicGenerationProvider(buildMinimaxMusicGenerationProvider("minimax-portal"));
    api.registerVideoGenerationProvider(buildMinimaxVideoGenerationProvider());
    api.registerVideoGenerationProvider(buildMinimaxVideoGenerationProvider("minimax-portal"));
    api.registerSpeechProvider(buildMinimaxSpeechProvider);
    api.registerWebSearchProvider(createMiniMaxWebSearchProvider());
  },
});
