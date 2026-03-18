import { definePluginEntry, type ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import type { ProviderAuthMethodNonInteractiveContext } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import {
  applyAuthProfileConfig,
  coerceSecretRef,
  normalizeSecretInput,
  upsertAuthProfile,
} from "openclaw/plugin-sdk/provider-auth";
import { githubCopilotLoginCommand } from "openclaw/plugin-sdk/provider-auth-login";
import { PROVIDER_ID, resolveCopilotForwardCompatModel } from "./models.js";
import { wrapCopilotAnthropicStream } from "./stream.js";
import { DEFAULT_COPILOT_API_BASE_URL, resolveCopilotApiToken } from "./token.js";
import { fetchCopilotUsage } from "./usage.js";

const DEFAULT_COPILOT_MODEL = "github-copilot/gpt-4o";
const COPILOT_ENV_VARS = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"];
const COPILOT_XHIGH_MODEL_IDS = ["gpt-5.2", "gpt-5.2-codex"] as const;

function buildGithubCopilotReplayPolicy(modelId?: string) {
  return (modelId?.toLowerCase() ?? "").includes("claude")
    ? {
        dropThinkingBlocks: true,
      }
    : {};
}

function resolveFirstGithubToken(params: { agentDir?: string; env: NodeJS.ProcessEnv }): {
  githubToken: string;
  hasProfile: boolean;
} {
  const authStore = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });
  const hasProfile = listProfilesForProvider(authStore, PROVIDER_ID).length > 0;
  const envToken =
    params.env.COPILOT_GITHUB_TOKEN ?? params.env.GH_TOKEN ?? params.env.GITHUB_TOKEN ?? "";
  const githubToken = envToken.trim();
  if (githubToken || !hasProfile) {
    return { githubToken, hasProfile };
  }

  const profileId = listProfilesForProvider(authStore, PROVIDER_ID)[0];
  const profile = profileId ? authStore.profiles[profileId] : undefined;
  if (profile?.type !== "token") {
    return { githubToken: "", hasProfile };
  }
  const directToken = profile.token?.trim() ?? "";
  if (directToken) {
    return { githubToken: directToken, hasProfile };
  }
  const tokenRef = coerceSecretRef(profile.tokenRef);
  if (tokenRef?.source === "env" && tokenRef.id.trim()) {
    return {
      githubToken: (params.env[tokenRef.id] ?? process.env[tokenRef.id] ?? "").trim(),
      hasProfile,
    };
  }
  return { githubToken: "", hasProfile };
}

function resolveGithubCopilotTokenFromFlagOrEnv(
  opts: Record<string, unknown> | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const flagValue = normalizeSecretInput(opts?.githubCopilotToken);
  if (flagValue) {
    return flagValue;
  }
  for (const envVar of COPILOT_ENV_VARS) {
    const value = normalizeSecretInput(env[envVar]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

async function runGitHubCopilotNonInteractiveAuth(
  ctx: ProviderAuthMethodNonInteractiveContext,
): Promise<OpenClawConfig | null> {
  const opts = ctx.opts as Record<string, unknown> | undefined;
  const token = resolveGithubCopilotTokenFromFlagOrEnv(opts, process.env);
  const profileId = "github-copilot:github";

  if (token) {
    // New token provided — upsert the auth profile.
    upsertAuthProfile({
      profileId,
      credential: {
        type: "token",
        provider: PROVIDER_ID,
        token,
      },
      agentDir: ctx.agentDir,
    });
  } else {
    // No token provided — check if a valid profile already exists.
    // This supports idempotent re-runs and config-reset scenarios.
    const authStore = ensureAuthProfileStore(ctx.agentDir, { allowKeychainPrompt: false });
    const existingProfiles = listProfilesForProvider(authStore, PROVIDER_ID);
    if (existingProfiles.length === 0) {
      ctx.runtime.error(
        "Missing --github-copilot-token (or COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN env var) for --auth-choice github-copilot.",
      );
      ctx.runtime.exit(1);
      return null;
    }
    // Existing profile found — continue to apply config and default model below.
  }

  let next = applyAuthProfileConfig(ctx.config, {
    profileId,
    provider: PROVIDER_ID,
    mode: "token",
  });

  // Set default model to match interactive flow, preserving any existing fallbacks.
  const existingModel = next.agents?.defaults?.model;
  const fallbacks =
    typeof existingModel === "object" && existingModel !== null && "fallbacks" in existingModel
      ? (existingModel as { fallbacks?: string[] }).fallbacks
      : undefined;
  next = {
    ...next,
    agents: {
      ...next.agents,
      defaults: {
        ...next.agents?.defaults,
        model: {
          ...(fallbacks ? { fallbacks } : undefined),
          primary: DEFAULT_COPILOT_MODEL,
        },
        models: {
          ...next.agents?.defaults?.models,
          [DEFAULT_COPILOT_MODEL]: next.agents?.defaults?.models?.[DEFAULT_COPILOT_MODEL] ?? {},
        },
      },
    },
  };

  return next;
}

async function runGitHubCopilotAuth(ctx: ProviderAuthContext) {
  await ctx.prompter.note(
    [
      "This will open a GitHub device login to authorize Copilot.",
      "Requires an active GitHub Copilot subscription.",
    ].join("\n"),
    "GitHub Copilot",
  );

  if (!process.stdin.isTTY) {
    await ctx.prompter.note("GitHub Copilot login requires an interactive TTY.", "GitHub Copilot");
    return { profiles: [] };
  }

  try {
    await githubCopilotLoginCommand({ yes: true, profileId: "github-copilot:github" }, ctx.runtime);
  } catch (err) {
    await ctx.prompter.note(`GitHub Copilot login failed: ${String(err)}`, "GitHub Copilot");
    return { profiles: [] };
  }

  const authStore = ensureAuthProfileStore(undefined, {
    allowKeychainPrompt: false,
  });
  const credential = authStore.profiles["github-copilot:github"];
  if (!credential || credential.type !== "token") {
    return { profiles: [] };
  }

  return {
    profiles: [
      {
        profileId: "github-copilot:github",
        credential,
      },
    ],
    defaultModel: DEFAULT_COPILOT_MODEL,
  };
}

export default definePluginEntry({
  id: "github-copilot",
  name: "GitHub Copilot Provider",
  description: "Bundled GitHub Copilot provider plugin",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "GitHub Copilot",
      docsPath: "/providers/models",
      envVars: COPILOT_ENV_VARS,
      auth: [
        {
          id: "device",
          label: "GitHub device login",
          hint: "Browser device-code flow",
          kind: "device_code",
          run: async (ctx) => await runGitHubCopilotAuth(ctx),
          runNonInteractive: async (ctx) => await runGitHubCopilotNonInteractiveAuth(ctx),
        },
      ],
      wizard: {
        setup: {
          choiceId: "github-copilot",
          choiceLabel: "GitHub Copilot",
          choiceHint: "Device login with your GitHub account",
          methodId: "device",
        },
      },
      catalog: {
        order: "late",
        run: async (ctx) => {
          const { githubToken, hasProfile } = resolveFirstGithubToken({
            agentDir: ctx.agentDir,
            env: ctx.env,
          });
          if (!hasProfile && !githubToken) {
            return null;
          }
          let baseUrl = DEFAULT_COPILOT_API_BASE_URL;
          if (githubToken) {
            try {
              const token = await resolveCopilotApiToken({
                githubToken,
                env: ctx.env,
              });
              baseUrl = token.baseUrl;
            } catch {
              baseUrl = DEFAULT_COPILOT_API_BASE_URL;
            }
          }
          return {
            provider: {
              baseUrl,
              models: [],
            },
          };
        },
      },
      resolveDynamicModel: (ctx) => resolveCopilotForwardCompatModel(ctx),
      wrapStreamFn: (ctx) => wrapCopilotAnthropicStream(ctx.streamFn),
      buildReplayPolicy: ({ modelId }) => buildGithubCopilotReplayPolicy(modelId),
      supportsXHighThinking: ({ modelId }) =>
        COPILOT_XHIGH_MODEL_IDS.includes(modelId.trim().toLowerCase() as never),
      prepareRuntimeAuth: async (ctx) => {
        const token = await resolveCopilotApiToken({
          githubToken: ctx.apiKey,
          env: ctx.env,
        });
        return {
          apiKey: token.token,
          baseUrl: token.baseUrl,
          expiresAt: token.expiresAt,
        };
      },
      resolveUsageAuth: async (ctx) => await ctx.resolveOAuthToken(),
      fetchUsageSnapshot: async (ctx) =>
        await fetchCopilotUsage(ctx.token, ctx.timeoutMs, ctx.fetchFn),
    });
  },
});
