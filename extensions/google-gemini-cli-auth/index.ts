import {
  buildOauthProviderAuthResult,
  emptyPluginConfigSchema,
  type ProviderFetchUsageSnapshotContext,
  type OpenClawPluginApi,
  type ProviderAuthContext,
  type ProviderResolveDynamicModelContext,
  type ProviderRuntimeModel,
} from "openclaw/plugin-sdk/google-gemini-cli-auth";
import { normalizeModelCompat } from "../../src/agents/model-compat.js";
import { fetchGeminiUsage } from "../../src/infra/provider-usage.fetch.js";
import { loginGeminiCliOAuth } from "./oauth.js";

const PROVIDER_ID = "google-gemini-cli";
const PROVIDER_LABEL = "Gemini CLI OAuth";
const DEFAULT_MODEL = "google-gemini-cli/gemini-3.1-pro-preview";
const GEMINI_3_1_PRO_PREFIX = "gemini-3.1-pro";
const GEMINI_3_1_FLASH_PREFIX = "gemini-3.1-flash";
const GEMINI_3_1_PRO_TEMPLATE_IDS = ["gemini-3-pro-preview"] as const;
const GEMINI_3_1_FLASH_TEMPLATE_IDS = ["gemini-3-flash-preview"] as const;
const ENV_VARS = [
  "OPENCLAW_GEMINI_OAUTH_CLIENT_ID",
  "OPENCLAW_GEMINI_OAUTH_CLIENT_SECRET",
  "GEMINI_CLI_OAUTH_CLIENT_ID",
  "GEMINI_CLI_OAUTH_CLIENT_SECRET",
];

function cloneFirstTemplateModel(params: {
  modelId: string;
  templateIds: readonly string[];
  ctx: ProviderResolveDynamicModelContext;
}): ProviderRuntimeModel | undefined {
  const trimmedModelId = params.modelId.trim();
  for (const templateId of [...new Set(params.templateIds)].filter(Boolean)) {
    const template = params.ctx.modelRegistry.find(
      PROVIDER_ID,
      templateId,
    ) as ProviderRuntimeModel | null;
    if (!template) {
      continue;
    }
    return normalizeModelCompat({
      ...template,
      id: trimmedModelId,
      name: trimmedModelId,
      reasoning: true,
    } as ProviderRuntimeModel);
  }
  return undefined;
}

function parseGoogleUsageToken(apiKey: string): string {
  try {
    const parsed = JSON.parse(apiKey) as { token?: unknown };
    if (typeof parsed?.token === "string") {
      return parsed.token;
    }
  } catch {
    // ignore
  }
  return apiKey;
}

async function fetchGeminiCliUsage(ctx: ProviderFetchUsageSnapshotContext) {
  return await fetchGeminiUsage(ctx.token, ctx.timeoutMs, ctx.fetchFn, PROVIDER_ID);
}

function resolveGeminiCliForwardCompatModel(
  ctx: ProviderResolveDynamicModelContext,
): ProviderRuntimeModel | undefined {
  const trimmed = ctx.modelId.trim();
  const lower = trimmed.toLowerCase();

  let templateIds: readonly string[];
  if (lower.startsWith(GEMINI_3_1_PRO_PREFIX)) {
    templateIds = GEMINI_3_1_PRO_TEMPLATE_IDS;
  } else if (lower.startsWith(GEMINI_3_1_FLASH_PREFIX)) {
    templateIds = GEMINI_3_1_FLASH_TEMPLATE_IDS;
  } else {
    return undefined;
  }

  return cloneFirstTemplateModel({
    modelId: trimmed,
    templateIds,
    ctx,
  });
}

const geminiCliPlugin = {
  id: "google-gemini-cli-auth",
  name: "Google Gemini CLI Auth",
  description: "OAuth flow for Gemini CLI (Google Code Assist)",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: PROVIDER_LABEL,
      docsPath: "/providers/models",
      aliases: ["gemini-cli"],
      envVars: ENV_VARS,
      auth: [
        {
          id: "oauth",
          label: "Google OAuth",
          hint: "PKCE + localhost callback",
          kind: "oauth",
          run: async (ctx: ProviderAuthContext) => {
            const spin = ctx.prompter.progress("Starting Gemini CLI OAuth…");
            try {
              const result = await loginGeminiCliOAuth({
                isRemote: ctx.isRemote,
                openUrl: ctx.openUrl,
                log: (msg) => ctx.runtime.log(msg),
                note: ctx.prompter.note,
                prompt: async (message) => String(await ctx.prompter.text({ message })),
                progress: spin,
              });

              spin.stop("Gemini CLI OAuth complete");
              return buildOauthProviderAuthResult({
                providerId: PROVIDER_ID,
                defaultModel: DEFAULT_MODEL,
                access: result.access,
                refresh: result.refresh,
                expires: result.expires,
                email: result.email,
                credentialExtra: { projectId: result.projectId },
                notes: ["If requests fail, set GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID."],
              });
            } catch (err) {
              spin.stop("Gemini CLI OAuth failed");
              await ctx.prompter.note(
                "Trouble with OAuth? Ensure your Google account has Gemini CLI access.",
                "OAuth help",
              );
              throw err;
            }
          },
        },
      ],
      resolveDynamicModel: (ctx) => resolveGeminiCliForwardCompatModel(ctx),
      resolveUsageAuth: async (ctx) => {
        const auth = await ctx.resolveOAuthToken();
        if (!auth) {
          return null;
        }
        return {
          ...auth,
          token: parseGoogleUsageToken(auth.token),
        };
      },
      fetchUsageSnapshot: async (ctx) => await fetchGeminiCliUsage(ctx),
    });
  },
};

export default geminiCliPlugin;
