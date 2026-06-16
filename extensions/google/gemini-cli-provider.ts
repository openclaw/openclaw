// Google provider module implements model/runtime integration.
import fs from "node:fs";
import type {
  OpenClawPluginApi,
  ProviderAuthContext,
  ProviderFetchUsageSnapshotContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { buildOauthProviderAuthResult } from "openclaw/plugin-sdk/provider-auth-result";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { fetchGeminiUsage } from "openclaw/plugin-sdk/provider-usage";
import {
  GOOGLE_GEMINI_CLI_PROVIDER_ID,
  resolveGeminiCliProfileCredentialsPath,
} from "./gemini-cli-auth-home.js";
import { formatGoogleOauthApiKey, parseGoogleUsageToken } from "./oauth-token-shared.js";
import { GOOGLE_GEMINI_PROVIDER_HOOKS } from "./provider-hooks.js";
import { isModernGoogleModel, resolveGoogleGeminiForwardCompatModel } from "./provider-models.js";

const PROVIDER_ID = GOOGLE_GEMINI_CLI_PROVIDER_ID;
const PROVIDER_LABEL = "Gemini CLI OAuth";
const DEFAULT_MODEL = "google/gemini-3.1-pro-preview";
const ENV_VARS = [
  "OPENCLAW_GEMINI_OAUTH_CLIENT_ID",
  "OPENCLAW_GEMINI_OAUTH_CLIENT_SECRET",
  "GEMINI_CLI_OAUTH_CLIENT_ID",
  "GEMINI_CLI_OAUTH_CLIENT_SECRET",
] as const;

let oauthRuntimeModulePromise: Promise<typeof import("./oauth.runtime.js")> | null = null;
type GeminiCliExternalAuthContext = Parameters<
  NonNullable<ProviderPlugin["resolveExternalAuthProfiles"]>
>[0];

const loadOauthRuntimeModule = async () => {
  oauthRuntimeModulePromise ??= import("./oauth.runtime.js");
  return await oauthRuntimeModulePromise;
};

async function fetchGeminiCliUsage(ctx: ProviderFetchUsageSnapshotContext) {
  return await fetchGeminiUsage(ctx.token, ctx.timeoutMs, ctx.fetchFn, PROVIDER_ID);
}

function normalizeString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (!payload) {
    return {};
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function readGeminiCliProfileCredential(agentDir: string, profileId: string) {
  const credentialsPath = resolveGeminiCliProfileCredentialsPath(agentDir, profileId);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(credentialsPath, "utf8")) as unknown;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const data = raw as Record<string, unknown>;
  const access = normalizeString(typeof data.access_token === "string" ? data.access_token : "");
  const refresh = normalizeString(typeof data.refresh_token === "string" ? data.refresh_token : "");
  const expires = data.expiry_date;
  if (!access || !refresh || typeof expires !== "number" || !Number.isFinite(expires)) {
    return null;
  }

  const idToken = normalizeString(typeof data.id_token === "string" ? data.id_token : "");
  const identity = idToken ? decodeJwtPayload(idToken) : {};
  const email = normalizeString(typeof identity.email === "string" ? identity.email : "");
  const accountId = normalizeString(typeof identity.sub === "string" ? identity.sub : "");
  return {
    type: "oauth" as const,
    provider: PROVIDER_ID,
    access,
    refresh,
    expires,
    ...(idToken ? { idToken } : {}),
    ...(email ? { email } : {}),
    ...(accountId ? { accountId } : {}),
  };
}

function resolveConfiguredGeminiCliOAuthProfileIds(ctx: GeminiCliExternalAuthContext): string[] {
  const profileIds = new Set<string>();
  for (const [profileId, profile] of Object.entries(ctx.config?.auth?.profiles ?? {})) {
    if (profile.provider === PROVIDER_ID && profile.mode === "oauth") {
      profileIds.add(profileId);
    }
  }
  for (const [profileId, credential] of Object.entries(ctx.store.profiles)) {
    if (credential.provider === PROVIDER_ID && credential.type === "oauth") {
      profileIds.add(profileId);
    }
  }
  return [...profileIds].toSorted();
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
              "This is an unofficial integration and is not endorsed by Google.",
              "Some users have reported account restrictions or suspensions after using third-party Gemini CLI and Antigravity OAuth clients.",
              "Proceed only if you understand and accept this risk.",
            ].join("\n"),
            "Google Gemini CLI caution",
          );

          const proceed = await ctx.prompter.confirm({
            message: "Continue with Google Gemini CLI OAuth?",
            initialValue: false,
          });
          if (!proceed) {
            await ctx.prompter.note("Skipped Google Gemini CLI OAuth setup.", "Setup skipped");
            return { profiles: [] };
          }

          const spin = ctx.prompter.progress("Starting Gemini CLI OAuth…");
          try {
            const { loginGeminiCliOAuth } = await loadOauthRuntimeModule();
            const result = await loginGeminiCliOAuth({
              isRemote: ctx.isRemote,
              openUrl: ctx.openUrl,
              log: (msg) => ctx.runtime.log(msg),
              note: ctx.prompter.note,
              prompt: async (message) => ctx.prompter.text({ message }),
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
    resolveExternalAuthProfiles: (ctx) => {
      const agentDir = normalizeString(ctx.agentDir);
      if (!agentDir) {
        return [];
      }
      return resolveConfiguredGeminiCliOAuthProfileIds(ctx).flatMap((profileId) => {
        const credential = readGeminiCliProfileCredential(agentDir, profileId);
        return credential ? [{ profileId, credential, persistence: "runtime-only" as const }] : [];
      });
    },
    ...GOOGLE_GEMINI_PROVIDER_HOOKS,
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
