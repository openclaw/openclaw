import {
  emptyPluginConfigSchema,
  type OpenClawPluginApi,
  type ProviderAuthContext,
  type ProviderResolveDynamicModelContext,
  type ProviderRuntimeModel,
} from "openclaw/plugin-sdk/core";
import { listProfilesForProvider } from "../../src/agents/auth-profiles/profiles.js";
import { ensureAuthProfileStore } from "../../src/agents/auth-profiles/store.js";
import { normalizeModelCompat } from "../../src/agents/model-compat.js";
import { coerceSecretRef } from "../../src/config/types.secrets.js";
import { githubCopilotLoginCommand } from "../../src/providers/github-copilot-auth.js";
import { DEFAULT_COPILOT_API_BASE_URL, resolveCopilotApiToken } from "./token.js";
import { fetchCopilotUsage } from "./usage.js";

const PROVIDER_ID = "github-copilot";
const COPILOT_ENV_VARS = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"];
const CODEX_GPT_53_MODEL_ID = "gpt-5.3-codex";
const CODEX_TEMPLATE_MODEL_IDS = ["gpt-5.2-codex"] as const;
const COPILOT_XHIGH_MODEL_IDS = ["gpt-5.2", "gpt-5.2-codex"] as const;

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

function resolveCopilotForwardCompatModel(
  ctx: ProviderResolveDynamicModelContext,
): ProviderRuntimeModel | undefined {
  const trimmedModelId = ctx.modelId.trim();
  if (trimmedModelId.toLowerCase() !== CODEX_GPT_53_MODEL_ID) {
    return undefined;
  }
  for (const templateId of CODEX_TEMPLATE_MODEL_IDS) {
    const template = ctx.modelRegistry.find(PROVIDER_ID, templateId) as ProviderRuntimeModel | null;
    if (!template) {
      continue;
    }
    return normalizeModelCompat({
      ...template,
      id: trimmedModelId,
      name: trimmedModelId,
    } as ProviderRuntimeModel);
  }
  return undefined;
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
    defaultModel: "github-copilot/gpt-4o",
  };
}

const githubCopilotPlugin = {
  id: "github-copilot",
  name: "GitHub Copilot Provider",
  description: "Bundled GitHub Copilot provider plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
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
      capabilities: {
        dropThinkingBlockModelHints: ["claude"],
      },
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
};

export default githubCopilotPlugin;
