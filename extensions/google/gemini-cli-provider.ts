import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
// Google provider module implements model/runtime integration.
import type {
  OpenClawPluginApi,
  ProviderAuthContext,
  ProviderFetchUsageSnapshotContext,
  ProviderResolveCliBackendAuthCredentialContext,
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
  "GEMINI_API_KEY",
] as const;

const loadOauthRuntimeModule = createLazyRuntimeModule(() => import("./oauth.runtime.js"));

async function fetchGeminiCliUsage(ctx: ProviderFetchUsageSnapshotContext) {
  return await fetchGeminiUsage(ctx.token, ctx.timeoutMs, ctx.fetchFn, PROVIDER_ID);
}

function normalizeString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeEmail(value: string | undefined): string | undefined {
  const normalized = normalizeString(value)?.toLowerCase();
  return normalized && normalized.includes("@") ? normalized : undefined;
}

function resolveEmailFromProfileId(profileId: string): string | undefined {
  const suffix = profileId.includes(":") ? profileId.slice(profileId.indexOf(":") + 1) : profileId;
  return normalizeEmail(suffix);
}

async function buildGeminiCliOAuthCredential(credential: OAuthCredential, profileId: string) {
  const accessToken = normalizeString(credential.access);
  if (!accessToken) {
    return null;
  }
  const refreshToken = normalizeString(credential.refresh);
  const projectId = normalizeString(credential.projectId);
  const email = normalizeEmail(credential.email);
  const expectedEmail = resolveEmailFromProfileId(profileId);
  if (!email) {
    const { importOfficialGeminiCliOAuthCredentials } = await loadOauthRuntimeModule();
    const imported = importOfficialGeminiCliOAuthCredentials();
    const importedEmail = normalizeEmail(imported?.email);
    const importedAccess = normalizeString(imported?.access);
    if (!imported || !importedEmail || !importedAccess) {
      throw new Error(
        "Legacy Gemini CLI OAuth profile is missing validated Google account identity. Re-import the official Gemini CLI cache.",
      );
    }
    if (expectedEmail && expectedEmail !== importedEmail) {
      throw new Error("Gemini CLI OAuth profile identity does not match the selected profile id.");
    }
    const importedRefresh = normalizeString(imported.refresh);
    const importedProjectId = normalizeString(imported.projectId);
    return {
      kind: "oauth" as const,
      providerId: PROVIDER_ID,
      profileId,
      accessToken: importedAccess,
      ...(importedRefresh ? { refreshToken: importedRefresh } : {}),
      ...(typeof imported.expires === "number" && Number.isFinite(imported.expires)
        ? { expiresAt: imported.expires }
        : {}),
      ...(importedProjectId ? { projectId: importedProjectId } : {}),
      email: importedEmail,
    };
  }
  if (expectedEmail && expectedEmail !== email) {
    throw new Error("Gemini CLI OAuth profile identity does not match the selected profile id.");
  }
  return {
    kind: "oauth" as const,
    providerId: PROVIDER_ID,
    profileId,
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(typeof credential.expires === "number" && Number.isFinite(credential.expires)
      ? { expiresAt: credential.expires }
      : {}),
    ...(projectId ? { projectId } : {}),
    email,
  };
}

async function resolveGeminiCliBackendAuthCredential(
  ctx: ProviderResolveCliBackendAuthCredentialContext,
) {
  if (ctx.provider !== PROVIDER_ID || ctx.credential.provider !== PROVIDER_ID) {
    return null;
  }
  if (ctx.credential.type !== "oauth") {
    return null;
  }

  // Do not refresh with OpenClaw-owned Google OAuth machinery. The Gemini CLI
  // owns its official OAuth client and can refresh from the staged OAuth cache.
  // OpenClaw only forwards the selected cached credential envelope.
  return await buildGeminiCliOAuthCredential(ctx.credential, ctx.profileId);
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
        label: "Google OAuth",
        hint: "PKCE + localhost callback",
        kind: "oauth",
        run: async (ctx: ProviderAuthContext) => {
          await ctx.prompter.note(
            [
              "OpenClaw will import credentials created by the official Gemini CLI login.",
              "It will not start its own Google OAuth client.",
              "If you have not signed in yet, run `gemini`, choose Sign in with Google, complete login, then return here.",
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
            const result = requireOfficialGeminiCliOAuthCredentials();

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
              ...(result.projectId ? { credentialExtra: { projectId: result.projectId } } : {}),
              ...(result.projectId
                ? {
                    notes: [
                      "If requests fail, set GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID.",
                    ],
                  }
                : {}),
            });
          } catch (err) {
            spin.stop("Gemini CLI OAuth import failed");
            await ctx.prompter.note(
              "Run the official Gemini CLI first: `gemini`, then choose Sign in with Google. For headless setups, use GEMINI_API_KEY with the `google` provider instead.",
              "Gemini CLI OAuth help",
            );
            throw err;
          }
        },
      },
    ],
    wizard: {
      setup: {
        choiceId: "google-gemini-cli",
        choiceLabel: "Gemini CLI OAuth",
        choiceHint: "Google OAuth with project-aware token payload",
        methodId: "oauth",
      },
    },
    resolveDynamicModel: (ctx) =>
      resolveGoogleGeminiForwardCompatModel({
        providerId: PROVIDER_ID,
        ctx,
      }),
    ...GOOGLE_GEMINI_PROVIDER_HOOKS,
    resolveCliBackendAuthCredential: resolveGeminiCliBackendAuthCredential,
    isModernModelRef: ({ modelId }) => isModernGoogleModel(modelId),
    formatApiKey: (cred) => formatGoogleOauthApiKey(cred),
    refreshOAuth: async (cred) => {
      const { refreshGeminiCliOAuthToken } = await loadOauthRuntimeModule();
      return await refreshGeminiCliOAuthToken(cred);
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
