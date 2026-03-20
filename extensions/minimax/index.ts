import {
  definePluginEntry,
  type ProviderAuthContext,
  type ProviderAuthResult,
  type ProviderCatalogContext,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  MINIMAX_OAUTH_MARKER,
  createProviderApiKeyAuthMethod,
  ensureAuthProfileStore,
  listProfilesForProvider,
} from "openclaw/plugin-sdk/provider-auth";
import { buildOauthProviderAuthResult } from "openclaw/plugin-sdk/provider-oauth";
import { fetchMinimaxUsage } from "openclaw/plugin-sdk/provider-usage";
import {
  minimaxMediaUnderstandingProvider,
  minimaxPortalMediaUnderstandingProvider,
} from "./media-understanding-provider.js";
import type { MiniMaxRegion } from "./oauth.js";
import { applyMinimaxApiConfig, applyMinimaxApiConfigCn } from "./onboard.js";
import { buildMinimaxPortalProvider, buildMinimaxProvider } from "./provider-catalog.js";

const API_PROVIDER_ID = "minimax";
const PORTAL_PROVIDER_ID = "minimax-portal";
const PROVIDER_LABEL = "MiniMax";
const DEFAULT_MODEL = "MiniMax-M2.7";
const DEFAULT_BASE_URL_CN = "https://api.minimaxi.com/anthropic";
const DEFAULT_BASE_URL_GLOBAL = "https://api.minimax.io/anthropic";

function getDefaultBaseUrl(region: MiniMaxRegion): string {
  return region === "cn" ? DEFAULT_BASE_URL_CN : DEFAULT_BASE_URL_GLOBAL;
}

function apiModelRef(modelId: string): string {
  return `${API_PROVIDER_ID}/${modelId}`;
}

function portalModelRef(modelId: string): string {
  return `${PORTAL_PROVIDER_ID}/${modelId}`;
}

function isModernMiniMaxModel(modelId: string): boolean {
  const lower = modelId.trim().toLowerCase();
  return lower.startsWith("minimax-m2.7") || lower.startsWith("minimax-m2.5");
}

function buildPortalProviderCatalog(params: { baseUrl: string; apiKey: string }) {
  return {
    ...buildMinimaxPortalProvider(),
    baseUrl: params.baseUrl,
    apiKey: params.apiKey,
  };
}

function resolveApiCatalog(ctx: ProviderCatalogContext) {
  const apiKey = ctx.resolveProviderApiKey(API_PROVIDER_ID).apiKey;
  if (!apiKey) {
    return null;
  }
  return {
    provider: {
      ...buildMinimaxProvider(),
      apiKey,
    },
  };
}

function resolvePortalCatalog(ctx: ProviderCatalogContext) {
  const explicitProvider = ctx.config.models?.providers?.[PORTAL_PROVIDER_ID];
  const envApiKey = ctx.resolveProviderApiKey(PORTAL_PROVIDER_ID).apiKey;
  const authStore = ensureAuthProfileStore(ctx.agentDir, {
    allowKeychainPrompt: false,
  });
  const hasProfiles = listProfilesForProvider(authStore, PORTAL_PROVIDER_ID).length > 0;
  const explicitApiKey =
    typeof explicitProvider?.apiKey === "string" ? explicitProvider.apiKey.trim() : undefined;
  const apiKey = envApiKey ?? explicitApiKey ?? (hasProfiles ? MINIMAX_OAUTH_MARKER : undefined);
  if (!apiKey) {
    return null;
  }

  const explicitBaseUrl =
    typeof explicitProvider?.baseUrl === "string" ? explicitProvider.baseUrl.trim() : undefined;

  return {
    provider: buildPortalProviderCatalog({
      baseUrl: explicitBaseUrl || DEFAULT_BASE_URL_GLOBAL,
      apiKey,
    }),
  };
}

function createOAuthHandler(region: MiniMaxRegion) {
  const defaultBaseUrl = getDefaultBaseUrl(region);
  const regionLabel = region === "cn" ? "CN" : "Global";

  return async (ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
    const progress = ctx.prompter.progress(`Starting MiniMax OAuth (${regionLabel})…`);
    try {
      const { loginMiniMaxPortalOAuth } = await import("./oauth.runtime.js");
      const result = await loginMiniMaxPortalOAuth({
        openUrl: ctx.openUrl,
        note: ctx.prompter.note,
        progress,
        region,
      });

      progress.stop("MiniMax OAuth complete");

      if (result.notification_message) {
        await ctx.prompter.note(result.notification_message, "MiniMax OAuth");
      }

      const baseUrl = result.resourceUrl || defaultBaseUrl;

      return buildOauthProviderAuthResult({
        providerId: PORTAL_PROVIDER_ID,
        defaultModel: portalModelRef(DEFAULT_MODEL),
        access: result.access,
        refresh: result.refresh,
        expires: result.expires,
        configPatch: {
          models: {
            providers: {
              [PORTAL_PROVIDER_ID]: {
                baseUrl,
                models: [],
              },
            },
          },
          agents: {
            defaults: {
              models: {
                [portalModelRef("MiniMax-M2.7")]: { alias: "minimax-m2.7" },
                [portalModelRef("MiniMax-M2.7-highspeed")]: {
                  alias: "minimax-m2.7-highspeed",
                },
                [portalModelRef("MiniMax-M2.5")]: { alias: "minimax-m2.5" },
                [portalModelRef("MiniMax-M2.5-highspeed")]: {
                  alias: "minimax-m2.5-highspeed",
                },
                [portalModelRef("MiniMax-M2.5-Lightning")]: {
                  alias: "minimax-m2.5-lightning",
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
      const errorMsg = err instanceof Error ? err.message : String(err);
      progress.stop(`MiniMax OAuth failed: ${errorMsg}`);
      await ctx.prompter.note(
        "If OAuth fails, verify your MiniMax account has portal access and try again.",
        "MiniMax OAuth",
      );
      throw err;
    }
  };
}

export default definePluginEntry({
  id: API_PROVIDER_ID,
  name: "MiniMax",
  description: "Bundled MiniMax API-key and OAuth provider plugin",
  register(api) {
    api.registerProvider({
      id: API_PROVIDER_ID,
      label: PROVIDER_LABEL,
      docsPath: "/providers/minimax",
      envVars: ["MINIMAX_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: API_PROVIDER_ID,
          methodId: "api-global",
          label: "MiniMax API key (Global)",
          hint: "Global endpoint - api.minimax.io",
          optionKey: "minimaxApiKey",
          flagName: "--minimax-api-key",
          envVar: "MINIMAX_API_KEY",
          promptMessage:
            "Enter MiniMax API key (sk-api- or sk-cp-)\nhttps://platform.minimax.io/user-center/basic-information/interface-key",
          profileId: "minimax:global",
          allowProfile: false,
          defaultModel: apiModelRef(DEFAULT_MODEL),
          expectedProviders: ["minimax"],
          applyConfig: (cfg) => applyMinimaxApiConfig(cfg),
          wizard: {
            choiceId: "minimax-global-api",
            choiceLabel: "MiniMax API key (Global)",
            choiceHint: "Global endpoint - api.minimax.io",
            groupId: "minimax",
            groupLabel: "MiniMax",
            groupHint: "M2.7 (recommended)",
          },
        }),
        createProviderApiKeyAuthMethod({
          providerId: API_PROVIDER_ID,
          methodId: "api-cn",
          label: "MiniMax API key (CN)",
          hint: "CN endpoint - api.minimaxi.com",
          optionKey: "minimaxApiKey",
          flagName: "--minimax-api-key",
          envVar: "MINIMAX_API_KEY",
          promptMessage:
            "Enter MiniMax CN API key (sk-api- or sk-cp-)\nhttps://platform.minimaxi.com/user-center/basic-information/interface-key",
          profileId: "minimax:cn",
          allowProfile: false,
          defaultModel: apiModelRef(DEFAULT_MODEL),
          expectedProviders: ["minimax", "minimax-cn"],
          applyConfig: (cfg) => applyMinimaxApiConfigCn(cfg),
          wizard: {
            choiceId: "minimax-cn-api",
            choiceLabel: "MiniMax API key (CN)",
            choiceHint: "CN endpoint - api.minimaxi.com",
            groupId: "minimax",
            groupLabel: "MiniMax",
            groupHint: "M2.7 (recommended)",
          },
        }),
      ],
      catalog: {
        order: "simple",
        run: async (ctx) => resolveApiCatalog(ctx),
      },
      resolveUsageAuth: async (ctx) => {
        const apiKey = ctx.resolveApiKeyFromConfigAndStore({
          envDirect: [ctx.env.MINIMAX_CODE_PLAN_KEY, ctx.env.MINIMAX_API_KEY],
        });
        return apiKey ? { token: apiKey } : null;
      },
      isModernModelRef: ({ modelId }) => isModernMiniMaxModel(modelId),
      fetchUsageSnapshot: async (ctx) =>
        await fetchMinimaxUsage(ctx.token, ctx.timeoutMs, ctx.fetchFn),
    });

    api.registerProvider({
      id: PORTAL_PROVIDER_ID,
      label: PROVIDER_LABEL,
      docsPath: "/providers/minimax",
      envVars: ["MINIMAX_OAUTH_TOKEN", "MINIMAX_API_KEY"],
      catalog: {
        run: async (ctx) => resolvePortalCatalog(ctx),
      },
      auth: [
        {
          id: "oauth",
          label: "MiniMax OAuth (Global)",
          hint: "Global endpoint - api.minimax.io",
          kind: "device_code",
          wizard: {
            choiceId: "minimax-global-oauth",
            choiceLabel: "MiniMax OAuth (Global)",
            choiceHint: "Global endpoint - api.minimax.io",
            groupId: "minimax",
            groupLabel: "MiniMax",
            groupHint: "M2.7 (recommended)",
          },
          run: createOAuthHandler("global"),
        },
        {
          id: "oauth-cn",
          label: "MiniMax OAuth (CN)",
          hint: "CN endpoint - api.minimaxi.com",
          kind: "device_code",
          wizard: {
            choiceId: "minimax-cn-oauth",
            choiceLabel: "MiniMax OAuth (CN)",
            choiceHint: "CN endpoint - api.minimaxi.com",
            groupId: "minimax",
            groupLabel: "MiniMax",
            groupHint: "M2.7 (recommended)",
          },
          run: createOAuthHandler("cn"),
        },
      ],
      isModernModelRef: ({ modelId }) => isModernMiniMaxModel(modelId),
    });
    api.registerMediaUnderstandingProvider(minimaxMediaUnderstandingProvider);
    api.registerMediaUnderstandingProvider(minimaxPortalMediaUnderstandingProvider);
  },
});
