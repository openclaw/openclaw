import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type {
  OpenClawPluginApi,
  OpenClawConfig,
  ProviderAuthContext,
  ProviderAuthResult,
  ProviderCatalogContext,
  ProviderCatalogResult,
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  MINIMAX_OAUTH_MARKER,
  buildOauthProviderAuthResult,
  isNonSecretApiKeyMarker,
} from "openclaw/plugin-sdk/provider-auth";
import { buildOpenAICompatibleLiveProviderCatalog } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-entry";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import {
  buildProviderReplayFamilyHooks,
  normalizeModelCompat,
} from "openclaw/plugin-sdk/provider-model-shared";
import { fetchMinimaxUsage } from "openclaw/plugin-sdk/provider-usage";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  isMiniMaxModernModelId,
  MINIMAX_DEFAULT_MODEL_ID,
  MINIMAX_TEXT_MODEL_ORDER,
} from "./api.js";
import {
  buildMinimaxApiModelDefinition,
  MINIMAX_API_BASE_URL,
  MINIMAX_CN_API_BASE_URL,
} from "./model-definitions.js";
import type { MiniMaxRegion } from "./oauth.js";
import { applyMinimaxApiConfig, applyMinimaxApiConfigCn } from "./onboard.js";
import {
  buildMinimaxModelDiscovery,
  buildMinimaxPortalProvider,
  buildMinimaxProvider,
  resolveMinimaxCatalogBaseUrl,
} from "./provider-catalog.js";
import {
  createMinimaxPortalProvider,
  createMinimaxProvider,
  minimaxAuthMethodMetadata,
} from "./provider-contract-api.js";
import { wrapMinimaxProviderStream } from "./stream.js";

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
    ...buildMinimaxPortalProvider(),
    baseUrl: explicitBaseUrl || buildMinimaxPortalProvider(ctx.env).baseUrl,
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
        credentialExtra: { authFlow: "device-code" },
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

function buildMinimaxApiProviderPlugin(): ProviderPlugin {
  return {
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
      const apiKey = ctx.resolveApiKeyFromConfigAndStore({
        providerIds: [API_PROVIDER_ID, PORTAL_PROVIDER_ID],
        envDirect: MINIMAX_USAGE_ENV_VAR_KEYS.map((name) => ctx.env[name]),
      });
      return apiKey ? { token: apiKey } : null;
    },
    ...MINIMAX_PROVIDER_HOOKS,
    resolveDynamicModel: (ctx) => resolveMinimaxDynamicModel({ providerId: API_PROVIDER_ID, ctx }),
    fetchUsageSnapshot: async (ctx) =>
      await fetchMinimaxUsage(ctx.token, ctx.timeoutMs, ctx.fetchFn, {
        baseUrl: resolveMinimaxUsageBaseUrl(ctx.config),
      }),
  };
}

function buildMinimaxPortalProviderPlugin(): ProviderPlugin {
  return {
    ...createMinimaxPortalProvider(),
    catalog: {
      run: resolvePortalCatalog,
    },
    staticCatalog: {
      run: async (ctx) => ({
        providers: { [PORTAL_PROVIDER_ID]: buildMinimaxPortalProvider(ctx.env) },
      }),
    },
    auth: [createMinimaxOAuthMethod("global"), createMinimaxOAuthMethod("cn")],
    ...MINIMAX_PROVIDER_HOOKS,
    resolveDynamicModel: (ctx) =>
      resolveMinimaxDynamicModel({ providerId: PORTAL_PROVIDER_ID, ctx }),
  };
}

export function registerMinimaxProviders(api: OpenClawPluginApi) {
  api.registerProvider(buildMinimaxApiProviderPlugin());
  api.registerProvider(buildMinimaxPortalProviderPlugin());
}
