import fs from "node:fs";
import type {
  OpenClawPluginApi,
  ProviderAuthContext,
  ProviderResolveCliBackendAuthCredentialContext,
} from "openclaw/plugin-sdk/plugin-entry";
import type { OAuthCredential } from "openclaw/plugin-sdk/provider-auth";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { GOOGLE_GEMINI_PROVIDER_HOOKS } from "./provider-hooks.js";
import { isModernGoogleModel, resolveGoogleGeminiForwardCompatModel } from "./provider-models.js";

const PROVIDER_ID = "google-antigravity";
const PROVIDER_LABEL = "Google Antigravity";
const DEFAULT_MODEL = "google-antigravity/gemini-3-flash";
const PROFILE_ID = "google-antigravity:antigravity-session";
const SESSION_MARKER = "antigravity-session";

type AntigravityExternalAuthProfile = {
  profileId: string;
  credential: OAuthCredential;
  persistence?: "runtime-only" | "persisted";
};

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function resolveAntigravityUserDataDir(env: NodeJS.ProcessEnv | undefined): string | undefined {
  return normalizeString(env?.ANTIGRAVITY_USER_DATA_DIR);
}

function antigravitySessionLooksUsable(userDataDir: string | undefined): boolean {
  if (!userDataDir) {
    return true;
  }
  try {
    return fs.statSync(userDataDir).isDirectory();
  } catch {
    return false;
  }
}

function buildAntigravityCredential(userDataDir?: string): OAuthCredential {
  return {
    type: "oauth",
    provider: PROVIDER_ID,
    access: SESSION_MARKER,
    ...(userDataDir ? { userDataDir } : {}),
    copyToAgents: false,
    displayName: "Antigravity app session",
  } as OAuthCredential;
}

function buildAntigravityConfigPatch() {
  return {
    agents: {
      defaults: {
        models: {
          [DEFAULT_MODEL]: {
            agentRuntime: { id: PROVIDER_ID },
          },
        },
      },
    },
  };
}

async function runAntigravityOAuthSetup(ctx: ProviderAuthContext) {
  const userDataDir = resolveAntigravityUserDataDir(ctx.env);
  await ctx.prompter.note(
    [
      "OpenClaw will use the signed-in Google Antigravity app session.",
      "It will not run the deprecated Gemini CLI OAuth client.",
      userDataDir
        ? `Using ANTIGRAVITY_USER_DATA_DIR=${userDataDir}.`
        : "Using the default Antigravity app session directory.",
      "OpenClaw will create a local Antigravity auth profile for the Antigravity CLI desktop handoff.",
    ].join("\n"),
    "Google Antigravity OAuth",
  );

  const proceed = await ctx.prompter.confirm({
    message: "Use the existing Antigravity app session for Google models?",
    initialValue: true,
  });

  if (!proceed) {
    await ctx.prompter.note("Skipped Google Antigravity OAuth setup.", "Setup skipped");
    return { profiles: [] };
  }

  if (!antigravitySessionLooksUsable(userDataDir)) {
    throw new Error(
      "ANTIGRAVITY_USER_DATA_DIR does not point to a readable Antigravity user-data directory.",
    );
  }

  return {
    profiles: [{ profileId: PROFILE_ID, credential: buildAntigravityCredential(userDataDir) }],
    configPatch: buildAntigravityConfigPatch(),
    notes: [
      "Uses Antigravity-owned app session state. No OpenClaw-owned Google OAuth callback is started.",
      "Registers the Antigravity CLI desktop handoff. Current Antigravity CLI builds launch the desktop app and return no stdout model text.",
    ],
  };
}

function resolveAntigravityCliBackendAuthCredential(
  ctx: ProviderResolveCliBackendAuthCredentialContext,
) {
  if (ctx.provider !== PROVIDER_ID || ctx.credential.provider !== PROVIDER_ID) {
    return null;
  }
  if (ctx.credential.type !== "oauth") {
    return null;
  }
  const userDataDir = normalizeString(
    (ctx.credential as OAuthCredential & { userDataDir?: unknown }).userDataDir,
  );
  return {
    kind: "oauth" as const,
    providerId: PROVIDER_ID,
    profileId: ctx.profileId,
    accessToken: SESSION_MARKER,
    ...(userDataDir ? { userDataDir } : {}),
  };
}

function resolveExternalAntigravityProfiles(ctx: {
  env: NodeJS.ProcessEnv;
}): AntigravityExternalAuthProfile[] {
  const userDataDir = resolveAntigravityUserDataDir(ctx.env);
  if (!userDataDir || !antigravitySessionLooksUsable(userDataDir)) {
    return [];
  }
  return [
    {
      profileId: PROFILE_ID,
      credential: buildAntigravityCredential(userDataDir),
      persistence: "runtime-only",
    },
  ];
}

function resolveSyntheticAntigravityAuth() {
  const userDataDir = resolveAntigravityUserDataDir(process.env);
  if (!userDataDir || !antigravitySessionLooksUsable(userDataDir)) {
    return null;
  }
  return {
    apiKey: SESSION_MARKER,
    source: "ANTIGRAVITY_USER_DATA_DIR",
    mode: "oauth" as const,
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
    resolveCliBackendAuthCredential: resolveAntigravityCliBackendAuthCredential,
    resolveExternalAuthProfiles: resolveExternalAntigravityProfiles,
    resolveSyntheticAuth: resolveSyntheticAntigravityAuth,
    isModernModelRef: ({ modelId }) => isModernGoogleModel(modelId),
  };
}

export function registerGoogleAntigravityProvider(api: OpenClawPluginApi) {
  api.registerProvider(buildGoogleAntigravityProvider());
}
