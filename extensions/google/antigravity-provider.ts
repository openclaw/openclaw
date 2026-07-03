import type { OpenClawPluginApi, ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { GOOGLE_GEMINI_PROVIDER_HOOKS } from "./provider-hooks.js";
import { isModernGoogleModel, resolveGoogleGeminiForwardCompatModel } from "./provider-models.js";

const PROVIDER_ID = "google-antigravity";
const PROVIDER_LABEL = "Google Antigravity";
async function runAntigravityOAuthSetup(ctx: ProviderAuthContext) {
  await ctx.prompter.note(
    [
      "OpenClaw will use the signed-in Google Antigravity app session.",
      "It will not run the deprecated Gemini CLI OAuth client.",
      "If Antigravity is not signed in yet, run `antigravity`, sign in there, then return here.",
      "OpenClaw records the Antigravity setup surface, but does not claim a runnable non-GUI Antigravity backend until that runtime bridge is proven.",
    ].join("\n"),
    "Google Antigravity OAuth",
  );

  const proceed = await ctx.prompter.confirm({
    message: "Use the existing Antigravity OAuth session for Google models?",
    initialValue: true,
  });

  if (!proceed) {
    await ctx.prompter.note("Skipped Google Antigravity OAuth setup.", "Setup skipped");
    return { profiles: [] };
  }

  return {
    profiles: [],
    notes: [
      "Uses Antigravity-owned OAuth/session state. No OpenClaw-owned Google OAuth callback is started.",
      "No runnable Antigravity CLI/backend credential is created by this setup until a non-GUI Antigravity runtime bridge is proven.",
    ],
  };
}

export function buildGoogleAntigravityProvider(): ProviderPlugin {
  return {
    id: PROVIDER_ID,
    label: PROVIDER_LABEL,
    docsPath: "/providers/models",
    aliases: ["antigravity", "google-ag"],
    envVars: ["ANTIGRAVITY_USER_DATA_DIR"],
    auth: [
      {
        id: "oauth",
        label: "Google Antigravity OAuth",
        hint: "Uses the signed-in Antigravity app session",
        kind: "oauth",
        run: async (ctx) => await runAntigravityOAuthSetup(ctx),
      },
    ],
    wizard: {
      setup: {
        choiceId: PROVIDER_ID,
        choiceLabel: PROVIDER_LABEL,
        choiceHint: "OAuth through Antigravity, replacing unsupported Gemini CLI OAuth",
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
  };
}

export function registerGoogleAntigravityProvider(api: OpenClawPluginApi) {
  api.registerProvider(buildGoogleAntigravityProvider());
}
