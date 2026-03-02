import {
  emptyPluginConfigSchema,
  type OpenClawPluginApi,
  type ProviderAuthContext,
  type ProviderAuthResult,
} from "openclaw/plugin-sdk";
import { loginMiniMaxPortalOAuth, type MiniMaxRegion } from "./oauth.js";

const PROVIDER_ID_GLOBAL = "minimax-portal";
const PROVIDER_ID_CN = "minimax-portal-cn";
const PROVIDER_LABEL_GLOBAL = "MiniMax (Global)";
const PROVIDER_LABEL_CN = "MiniMax (CN)";
const DEFAULT_MODEL = "MiniMax-M2.5";
const DEFAULT_BASE_URL_CN = "https://api.minimaxi.com/anthropic";
const DEFAULT_BASE_URL_GLOBAL = "https://api.minimax.io/anthropic";
const DEFAULT_CONTEXT_WINDOW = 200000;
const DEFAULT_MAX_TOKENS = 8192;
const OAUTH_PLACEHOLDER = "minimax-oauth";

function getProviderConfig(region: MiniMaxRegion) {
  return region === "cn"
    ? { id: PROVIDER_ID_CN, label: PROVIDER_LABEL_CN, baseUrl: DEFAULT_BASE_URL_CN }
    : { id: PROVIDER_ID_GLOBAL, label: PROVIDER_LABEL_GLOBAL, baseUrl: DEFAULT_BASE_URL_GLOBAL };
}

function modelRef(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

function buildModelDefinition(params: {
  id: string;
  name: string;
  input: Array<"text" | "image">;
  reasoning?: boolean;
}) {
  return {
    id: params.id,
    name: params.name,
    reasoning: params.reasoning ?? false,
    input: params.input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}

function createOAuthHandler(region: MiniMaxRegion) {
  const providerConfig = getProviderConfig(region);
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

      const profileId = `${providerConfig.id}:default`;
      const baseUrl = result.resourceUrl || providerConfig.baseUrl;

      return {
        profiles: [
          {
            profileId,
            credential: {
              type: "oauth" as const,
              provider: providerConfig.id,
              access: result.access,
              refresh: result.refresh,
              expires: result.expires,
            },
          },
        ],
        configPatch: {
          models: {
            providers: {
              [providerConfig.id]: {
                baseUrl,
                apiKey: OAUTH_PLACEHOLDER,
                api: "anthropic-messages",
                models: [
                  buildModelDefinition({
                    id: "MiniMax-M2.1",
                    name: "MiniMax M2.1",
                    input: ["text"],
                  }),
                  buildModelDefinition({
                    id: "MiniMax-M2.5",
                    name: "MiniMax M2.5",
                    input: ["text"],
                    reasoning: true,
                  }),
                ],
              },
            },
          },
          agents: {
            defaults: {
              models: {
                [modelRef(providerConfig.id, "MiniMax-M2.1")]: {
                  alias: `minimax-m2.1${region === "cn" ? "-cn" : ""}`,
                },
                [modelRef(providerConfig.id, "MiniMax-M2.5")]: {
                  alias: `minimax-m2.5${region === "cn" ? "-cn" : ""}`,
                },
              },
            },
          },
        },
        defaultModel: modelRef(providerConfig.id, DEFAULT_MODEL),
        notes: [
          "MiniMax OAuth tokens auto-refresh. Re-run login if refresh fails or access is revoked.",
          `Base URL defaults to ${providerConfig.baseUrl}. Override models.providers.${providerConfig.id}.baseUrl if needed.`,
          ...(result.notification_message ? [result.notification_message] : []),
        ],
      };
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

const minimaxPortalPlugin = {
  id: "minimax-portal-auth",
  name: "MiniMax OAuth",
  description: "OAuth flow for MiniMax models",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    // Global provider (api.minimax.io)
    api.registerProvider({
      id: PROVIDER_ID_GLOBAL,
      label: PROVIDER_LABEL_GLOBAL,
      docsPath: "/providers/minimax",
      aliases: ["minimax", "minimax-global"],
      auth: [
        {
          id: "oauth",
          label: "MiniMax OAuth (Global)",
          hint: "Global endpoint - api.minimax.io",
          kind: "device_code",
          run: createOAuthHandler("global"),
        },
      ],
    });

    // CN provider (api.minimaxi.com)
    api.registerProvider({
      id: PROVIDER_ID_CN,
      label: PROVIDER_LABEL_CN,
      docsPath: "/providers/minimax",
      aliases: ["minimax-cn"],
      auth: [
        {
          id: "oauth",
          label: "MiniMax OAuth (CN)",
          hint: "CN endpoint - api.minimaxi.com",
          kind: "device_code",
          run: createOAuthHandler("cn"),
        },
      ],
    });
  },
};

export default minimaxPortalPlugin;
