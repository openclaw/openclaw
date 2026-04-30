import { formatCliCommand } from "openclaw/plugin-sdk/cli-runtime";
import type {
  OpenClawPluginApi,
  ProviderAuthContext,
  ProviderAuthMethodNonInteractiveContext,
  ProviderFetchUsageSnapshotContext,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  type OpenClawConfig as ProviderAuthConfig,
  type ProviderAuthResult,
} from "openclaw/plugin-sdk/provider-auth";
import { buildOauthProviderAuthResult } from "openclaw/plugin-sdk/provider-auth-result";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import { fetchGeminiUsage } from "openclaw/plugin-sdk/provider-usage";
import {
  readGeminiCliCredentialsForSetup,
  readGeminiCliCredentialsForSetupNonInteractive,
} from "./cli-auth-seam.js";
import {
  ensureGeminiCliInstalled,
  GEMINI_CLI_NPM_PACKAGE,
  runGeminiCliLogin,
} from "./cli-install.js";
import {
  buildGoogleGeminiCliMigrationResult,
  GEMINI_CLI_DEFAULT_ALLOWLIST_REFS,
  GEMINI_CLI_DEFAULT_MODEL_REF,
} from "./cli-migration.js";
import { formatGoogleOauthApiKey, parseGoogleUsageToken } from "./oauth-token-shared.js";
import { GOOGLE_GEMINI_PROVIDER_HOOKS } from "./provider-hooks.js";
import { isModernGoogleModel, resolveGoogleGeminiForwardCompatModel } from "./provider-models.js";

const PROVIDER_ID = "google-gemini-cli";
const PROVIDER_LABEL = "Gemini CLI OAuth";
const DEFAULT_MODEL = "google/gemini-3.1-pro-preview";
const ENV_VARS = [
  "OPENCLAW_GEMINI_OAUTH_CLIENT_ID",
  "OPENCLAW_GEMINI_OAUTH_CLIENT_SECRET",
  "GEMINI_CLI_OAUTH_CLIENT_ID",
  "GEMINI_CLI_OAUTH_CLIENT_SECRET",
] as const;

const GOOGLE_GEMINI_CLI_PROVIDER_HOOKS = {
  ...GOOGLE_GEMINI_PROVIDER_HOOKS,
  ...buildProviderToolCompatFamilyHooks("gemini"),
};

async function fetchGeminiCliUsage(ctx: ProviderFetchUsageSnapshotContext) {
  return await fetchGeminiUsage(ctx.token, ctx.timeoutMs, ctx.fetchFn, PROVIDER_ID);
}

async function runGoogleGeminiCliSubscriptionAuth(
  ctx: ProviderAuthContext,
): Promise<ProviderAuthResult> {
  const installed = await ensureGeminiCliInstalled({
    prompter: ctx.prompter,
    runtime: ctx.runtime,
  });
  if (!installed.ok) {
    throw new Error(installed.reason);
  }

  let credential = readGeminiCliCredentialsForSetup();
  if (!credential) {
    await ctx.prompter.note(
      [
        "Gemini CLI is installed but not signed in to your Google account.",
        "OpenClaw needs an active Gemini subscription session to run requests through your plan.",
      ].join("\n"),
      "Gemini CLI sign-in",
    );
    const shouldLogin = await ctx.prompter.confirm({
      message: `Run ${formatCliCommand("gemini")} now to start the Google sign-in flow?`,
      initialValue: true,
    });
    if (!shouldLogin) {
      throw new Error(
        [
          "Gemini CLI sign-in was declined.",
          `Run ${formatCliCommand("gemini")} manually and complete the Google sign-in, then re-run this setup.`,
        ].join("\n"),
      );
    }
    runGeminiCliLogin(ctx.runtime);
    credential = readGeminiCliCredentialsForSetup();
    if (!credential) {
      throw new Error(
        [
          "Gemini CLI sign-in did not complete.",
          `Run ${formatCliCommand("gemini")} again, complete the Google sign-in, then re-run this setup.`,
        ].join("\n"),
      );
    }
  }
  return buildGoogleGeminiCliMigrationResult(ctx.config, credential);
}

async function runGoogleGeminiCliSubscriptionNonInteractive(ctx: {
  config: ProviderAuthMethodNonInteractiveContext["config"];
  runtime: ProviderAuthMethodNonInteractiveContext["runtime"];
}): Promise<ProviderAuthConfig | null> {
  const credential = readGeminiCliCredentialsForSetupNonInteractive();
  if (!credential) {
    ctx.runtime.error(
      [
        'Auth choice "google-gemini-subscription" requires Gemini CLI installed and signed in on this host.',
        `Install Gemini CLI: npm install -g ${GEMINI_CLI_NPM_PACKAGE}`,
        `Then sign in by running: ${formatCliCommand("gemini")} (Google sign-in opens in your browser)`,
      ].join("\n"),
    );
    ctx.runtime.exit(1);
    return null;
  }

  const result = buildGoogleGeminiCliMigrationResult(ctx.config, credential);
  const currentDefaults = ctx.config.agents?.defaults;
  return {
    ...ctx.config,
    ...result.configPatch,
    agents: {
      ...ctx.config.agents,
      ...result.configPatch?.agents,
      defaults: {
        ...currentDefaults,
        ...result.configPatch?.agents?.defaults,
        model: {
          ...(currentDefaults?.model && typeof currentDefaults.model === "object"
            ? currentDefaults.model
            : {}),
          primary: result.defaultModel,
        },
      },
    },
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
        id: "cli",
        label: "Gemini subscription (no API key)",
        hint: "Use your Gemini Advanced/Pro subscription via the Gemini CLI in headless mode",
        kind: "custom",
        wizard: {
          choiceId: "google-gemini-subscription",
          choiceLabel: "Gemini subscription (no API key needed)",
          choiceHint: "Runs Gemini through the Gemini CLI in headless mode using your Google account",
          assistantPriority: -50,
          groupId: "google",
          groupLabel: "Google",
          groupHint: "Gemini subscription + API key + OAuth",
          modelAllowlist: {
            allowedKeys: [...GEMINI_CLI_DEFAULT_ALLOWLIST_REFS],
            initialSelections: [GEMINI_CLI_DEFAULT_MODEL_REF],
            message: "Gemini models",
          },
        },
        run: async (ctx: ProviderAuthContext) => await runGoogleGeminiCliSubscriptionAuth(ctx),
        runNonInteractive: async (ctx: ProviderAuthMethodNonInteractiveContext) =>
          await runGoogleGeminiCliSubscriptionNonInteractive({
            config: ctx.config,
            runtime: ctx.runtime,
          }),
      },
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
            const { loginGeminiCliOAuth } = await import("./oauth.runtime.js");
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
                    agentRuntime: { id: PROVIDER_ID },
                    models: {
                      [DEFAULT_MODEL]: {},
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
    ...GOOGLE_GEMINI_CLI_PROVIDER_HOOKS,
    isModernModelRef: ({ modelId }) => isModernGoogleModel(modelId),
    formatApiKey: (cred) => formatGoogleOauthApiKey(cred),
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
