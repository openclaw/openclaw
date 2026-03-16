import {
  buildOauthProviderAuthResult,
  emptyPluginConfigSchema,
  type OpenClawPluginApi,
  type ProviderAuthContext,
  type ProviderAuthResult,
  type ProviderCatalogContext,
} from "openclaw/plugin-sdk/minimax-portal-auth";
import { ensureAuthProfileStore, listProfilesForProvider } from "../../src/agents/auth-profiles.js";
import { MINIMAX_OAUTH_MARKER } from "../../src/agents/model-auth-markers.js";
import {
  buildMinimaxPortalProvider,
  buildMinimaxProvider,
} from "../../src/agents/models-config.providers.static.js";
import { fetchMinimaxUsage } from "../../src/infra/provider-usage.fetch.js";
import { loginMiniMaxPortalOAuth, type MiniMaxRegion } from "./oauth.js";

const API_PROVIDER_ID = "minimax";
const PORTAL_PROVIDER_ID = "minimax-portal";
const PROVIDER_LABEL = "MiniMax";
const DEFAULT_MODEL = "MiniMax-M2.5";
const DEFAULT_BASE_URL_CN = "https://api.minimaxi.com/anthropic";
const DEFAULT_BASE_URL_GLOBAL = "https://api.minimax.io/anthropic";

function getDefaultBaseUrl(region: MiniMaxRegion): string {
  return region === "cn" ? DEFAULT_BASE_URL_CN : DEFAULT_BASE_URL_GLOBAL;
}

function modelRef(modelId: string): string {
  return `${PORTAL_PROVIDER_ID}/${modelId}`;
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
        defaultModel: modelRef(DEFAULT_MODEL),
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
                [modelRef("MiniMax-M2.5")]: { alias: "minimax-m2.5" },
                [modelRef("MiniMax-M2.5-highspeed")]: {
                  alias: "minimax-m2.5-highspeed",
                },
                [modelRef("MiniMax-M2.5-Lightning")]: {
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

const minimaxPlugin = {
  id: API_PROVIDER_ID,
  name: "MiniMax",
  description: "Bundled MiniMax API-key and OAuth provider plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: API_PROVIDER_ID,
      label: PROVIDER_LABEL,
      docsPath: "/providers/minimax",
      envVars: ["MINIMAX_API_KEY"],
      auth: [],
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
      fetchUsageSnapshot: async (ctx) =>
        await fetchMinimaxUsage(ctx.token, ctx.timeoutMs, ctx.fetchFn),
    });

    api.registerProvider({
      id: PORTAL_PROVIDER_ID,
      label: PROVIDER_LABEL,
      docsPath: "/providers/minimax",
      catalog: {
        run: async (ctx) => resolvePortalCatalog(ctx),
      },
      auth: [
        {
          id: "oauth",
          label: "MiniMax OAuth (Global)",
          hint: "Global endpoint - api.minimax.io",
          kind: "device_code",
          run: createOAuthHandler("global"),
        },
        {
          id: "oauth-cn",
          label: "MiniMax OAuth (CN)",
          hint: "CN endpoint - api.minimaxi.com",
          kind: "device_code",
          run: createOAuthHandler("cn"),
        },
      ],
    });
  },
};

export default minimaxPlugin;
