import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
// Google provider module implements model/runtime integration.
import type {
  OpenClawPluginApi,
  ProviderAuthContext,
  ProviderFetchUsageSnapshotContext,
} from "openclaw/plugin-sdk/plugin-entry";
import type { OAuthCredential } from "openclaw/plugin-sdk/provider-auth";
import { buildOauthProviderAuthResult } from "openclaw/plugin-sdk/provider-auth-result";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { fetchGeminiUsage } from "openclaw/plugin-sdk/provider-usage";
import { GOOGLE_GEMINI_CLI_PROVIDER_ID } from "./gemini-cli-auth-home.js";
import { formatGoogleOauthApiKey, parseGoogleUsageToken } from "./oauth-token-shared.js";
import { GOOGLE_GEMINI_PROVIDER_HOOKS } from "./provider-hooks.js";
import { isModernGoogleModel, resolveGoogleGeminiForwardCompatModel } from "./provider-models.js";

const PROVIDER_ID = GOOGLE_GEMINI_CLI_PROVIDER_ID;
const PROVIDER_LABEL = "Gemini CLI OAuth";
const DEFAULT_MODEL = "google/gemini-3.1-pro-preview";
const ENV_VARS = [
  "GEMINI_CLI_HOME",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_PROJECT_ID",
] as const;

const loadOauthRuntimeModule = createLazyRuntimeModule(() => import("./oauth.runtime.js"));

async function fetchGeminiCliUsage(ctx: ProviderFetchUsageSnapshotContext) {
  return await fetchGeminiUsage(ctx.token, ctx.timeoutMs, ctx.fetchFn, PROVIDER_ID);
}

function normalizeEmail(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized?.includes("@") ? normalized : undefined;
}

function buildImportedOAuthCredential(result: {
  access: string;
  refresh: string;
  expires: number;
  email?: string;
  projectId?: string;
  idToken?: string;
}): OAuthCredential {
  return {
    type: "oauth",
    provider: PROVIDER_ID,
    access: result.access,
    refresh: result.refresh,
    expires: result.expires,
    ...(result.email ? { email: result.email } : {}),
    ...(result.projectId ? { projectId: result.projectId } : {}),
    ...(result.idToken ? { idToken: result.idToken } : {}),
  };
}

export function buildGoogleGeminiCliProvider(): ProviderPlugin {
  return {
    id: PROVIDER_ID,
    label: PROVIDER_LABEL,
    docsPath: "/providers/models",
    aliases: ["gemini-cli"],
    envVars: [...ENV_VARS],
    auth: [
      {
        id: "oauth",
        label: "Gemini CLI official OAuth cache",
        hint: "Import the official Gemini CLI sign-in cache",
        kind: "oauth",
        run: async (ctx: ProviderAuthContext) => {
          await ctx.prompter.note(
            [
              "OpenClaw imports credentials created by the official Gemini CLI.",
              "It does not start or own a Google OAuth client for this provider.",
              "Run `gemini`, choose Sign in with Google, and complete login before continuing.",
            ].join("\n"),
            "Gemini CLI OAuth import",
          );

          const proceed = await ctx.prompter.confirm({
            message: "Import the official Gemini CLI OAuth cache now?",
            initialValue: true,
          });
          if (!proceed) {
            await ctx.prompter.note("Skipped Google Gemini CLI OAuth setup.", "Setup skipped");
            return { profiles: [] };
          }

          const spin = ctx.prompter.progress("Importing Gemini CLI OAuth cache...");
          try {
            const { requireOfficialGeminiCliOAuthCredentials } = await loadOauthRuntimeModule();
            const result = requireOfficialGeminiCliOAuthCredentials(ctx.env);

            spin.stop("Gemini CLI OAuth cache imported");
            return buildOauthProviderAuthResult({
              providerId: PROVIDER_ID,
              defaultModel: DEFAULT_MODEL,
              access: result.access,
              refresh: result.refresh,
              expires: result.expires,
              email: result.email,
              configPatch: {
                agents: {
                  defaults: {
                    models: {
                      [DEFAULT_MODEL]: { agentRuntime: { id: PROVIDER_ID } },
                    },
                  },
                },
              },
              credentialExtra: {
                ...(result.projectId ? { projectId: result.projectId } : {}),
                ...(result.idToken ? { idToken: result.idToken } : {}),
              },
              notes: [
                "Gemini CLI owns token refresh. If the imported cache expires, run `gemini` again and re-import it.",
              ],
            });
          } catch (error) {
            spin.stop("Gemini CLI OAuth import failed");
            await ctx.prompter.note(
              "Run the official Gemini CLI first: `gemini`, then choose Sign in with Google. For API-key use, configure GEMINI_API_KEY with the `google` provider instead.",
              "Gemini CLI OAuth help",
            );
            throw error;
          }
        },
      },
    ],
    wizard: {
      setup: {
        choiceId: PROVIDER_ID,
        choiceLabel: "Gemini CLI official OAuth cache",
        choiceHint:
          "Run `gemini`, sign in with Google, then import the cache from GEMINI_CLI_HOME or ~/.gemini.",
        methodId: "oauth",
      },
    },
    resolveDynamicModel: (ctx) =>
      resolveGoogleGeminiForwardCompatModel({
        providerId: PROVIDER_ID,
        ctx,
      }),
    ...GOOGLE_GEMINI_PROVIDER_HOOKS,
    isModernModelRef: ({ modelId }) => isModernGoogleModel(modelId),
    formatApiKey: (cred) => formatGoogleOauthApiKey(cred),
    refreshOAuth: async (cred) => {
      const { requireOfficialGeminiCliOAuthCredentials } = await loadOauthRuntimeModule();
      const result = requireOfficialGeminiCliOAuthCredentials();
      const expectedEmail = normalizeEmail(cred.email);
      const importedEmail = normalizeEmail(result.email);
      if (expectedEmail && importedEmail !== expectedEmail) {
        throw new Error(
          `Official Gemini CLI active account ${importedEmail ?? "unknown"} does not match selected profile ${expectedEmail}.`,
        );
      }
      return buildImportedOAuthCredential(result);
    },
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
  };
}

export function registerGoogleGeminiCliProvider(api: OpenClawPluginApi) {
  api.registerProvider(buildGoogleGeminiCliProvider());
}
