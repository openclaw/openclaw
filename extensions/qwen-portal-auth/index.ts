import { ensureAuthProfileStore, listProfilesForProvider } from "openclaw/plugin-sdk/agent-runtime";
import { QWEN_OAUTH_MARKER } from "openclaw/plugin-sdk/agent-runtime";
import {
  buildOauthProviderAuthResult,
  definePluginEntry,
  type ProviderAuthContext,
  type ProviderCatalogContext,
} from "openclaw/plugin-sdk/qwen-portal-auth";
import { refreshQwenPortalCredentials } from "openclaw/plugin-sdk/qwen-portal-auth";
import { loginQwenPortalOAuth } from "./oauth.js";
import { buildQwenPortalProvider, QWEN_PORTAL_BASE_URL } from "./provider-catalog.js";

const PROVIDER_ID = "qwen-portal";
const PROVIDER_LABEL = "Qwen";
const DEFAULT_MODEL = "qwen-portal/coder-model";
const DEFAULT_BASE_URL = QWEN_PORTAL_BASE_URL;

function normalizeBaseUrl(value: string | undefined): string {
  const raw = value?.trim() || DEFAULT_BASE_URL;
  const withProtocol = raw.startsWith("http") ? raw : `https://${raw}`;
  return withProtocol.endsWith("/v1") ? withProtocol : `${withProtocol.replace(/\/+$/, "")}/v1`;
}

function buildProviderCatalog(params: { baseUrl: string; apiKey: string }) {
  return {
    ...buildQwenPortalProvider(),
    baseUrl: params.baseUrl,
    apiKey: params.apiKey,
  };
}

function resolveCatalog(ctx: ProviderCatalogContext) {
  const explicitProvider = ctx.config.models?.providers?.[PROVIDER_ID];
  const envApiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
  const authStore = ensureAuthProfileStore(ctx.agentDir, {
    allowKeychainPrompt: false,
  });
  const hasProfiles = listProfilesForProvider(authStore, PROVIDER_ID).length > 0;
  const explicitApiKey =
    typeof explicitProvider?.apiKey === "string" ? explicitProvider.apiKey.trim() : undefined;
  const apiKey = envApiKey ?? explicitApiKey ?? (hasProfiles ? QWEN_OAUTH_MARKER : undefined);
  if (!apiKey) {
    return null;
  }

  const explicitBaseUrl =
    typeof explicitProvider?.baseUrl === "string" ? explicitProvider.baseUrl : undefined;

  return {
    provider: buildProviderCatalog({
      baseUrl: normalizeBaseUrl(explicitBaseUrl),
      apiKey,
    }),
  };
}

export default definePluginEntry({
  id: "qwen-portal-auth",
  name: "Qwen OAuth",
  description: "OAuth flow for Qwen (free-tier) models",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: PROVIDER_LABEL,
      docsPath: "/providers/qwen",
      aliases: ["qwen"],
      envVars: ["QWEN_OAUTH_TOKEN", "QWEN_PORTAL_API_KEY"],
      catalog: {
        run: async (ctx: ProviderCatalogContext) => resolveCatalog(ctx),
      },
      auth: [
        {
          id: "device",
          label: "Qwen OAuth",
          hint: "Device code login",
          kind: "device_code",
          run: async (ctx: ProviderAuthContext) => {
            const progress = ctx.prompter.progress("Starting Qwen OAuth…");
            try {
              const result = await loginQwenPortalOAuth({
                openUrl: ctx.openUrl,
                note: ctx.prompter.note,
                progress,
              });

              progress.stop("Qwen OAuth complete");

              const baseUrl = normalizeBaseUrl(result.resourceUrl);

              return buildOauthProviderAuthResult({
                providerId: PROVIDER_ID,
                defaultModel: DEFAULT_MODEL,
                access: result.access,
                refresh: result.refresh,
                expires: result.expires,
                configPatch: {
                  models: {
                    providers: {
                      [PROVIDER_ID]: {
                        baseUrl,
                        models: [],
                      },
                    },
                  },
                  agents: {
                    defaults: {
                      models: {
                        "qwen-portal/coder-model": { alias: "qwen" },
                        "qwen-portal/vision-model": {},
                      },
                    },
                  },
                },
                notes: [
                  "Qwen OAuth tokens auto-refresh. Re-run login if refresh fails or access is revoked.",
                  `Base URL defaults to ${DEFAULT_BASE_URL}. Override models.providers.${PROVIDER_ID}.baseUrl if needed.`,
                ],
              });
            } catch (err) {
              progress.stop("Qwen OAuth failed");
              await ctx.prompter.note(
                "If OAuth fails, verify your Qwen account has portal access and try again.",
                "Qwen OAuth",
              );
              throw err;
            }
          },
        },
      ],
      wizard: {
        setup: {
          choiceId: "qwen-portal",
          choiceLabel: "Qwen OAuth",
          choiceHint: "Device code login",
          methodId: "device",
        },
      },
      refreshOAuth: async (cred) => ({
        ...cred,
        ...(await refreshQwenPortalCredentials(cred)),
        type: "oauth",
        provider: PROVIDER_ID,
        email: cred.email,
      }),
    });
  },
});
