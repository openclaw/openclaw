import { resolvePluginConfigObject, type OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { definePluginEntry, type ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import { ensureAuthProfileStore } from "openclaw/plugin-sdk/provider-auth";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
import { resolveFirstGithubToken } from "./auth.js";
import { githubCopilotMemoryEmbeddingProviderAdapter } from "./embeddings.js";
import { fetchCopilotModels } from "./models-api.js";
import { mapCopilotModels, type MappedCopilotModelWithCapabilities } from "./models-mapping.js";
import { PROVIDER_ID, resolveCopilotForwardCompatModel } from "./models.js";
import { buildGithubCopilotReplayPolicy } from "./replay-policy.js";
import { resolveThinkingProfileFromCapabilities } from "./thinking.js";
import { wrapCopilotProviderStream } from "./stream.js";

const COPILOT_ENV_VARS = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"];

/**
 * Module-level cache for API-fetched model capabilities.
 * Populated by fetchAndCacheModels() and consumed by resolveThinkingProfile().
 */
let cachedModelCapabilities = new Map<string, MappedCopilotModelWithCapabilities>();

/** In-flight fetch promise to prevent concurrent API calls. */
let fetchModelsPromise: Promise<MappedCopilotModelWithCapabilities[]> | null = null;

async function fetchAndCacheModels(
  config: OpenClawConfig | undefined,
  env: NodeJS.ProcessEnv,
): Promise<MappedCopilotModelWithCapabilities[]> {
  if (cachedModelCapabilities.size > 0) {
    return [...cachedModelCapabilities.values()];
  }
  if (fetchModelsPromise) {
    return fetchModelsPromise;
  }
  fetchModelsPromise = (async () => {
    try {
      const { DEFAULT_COPILOT_API_BASE_URL, resolveCopilotApiToken } =
        await loadGithubCopilotRuntime();
      const { githubToken } = await resolveFirstGithubToken({
        config,
        env,
      });
      if (!githubToken) {
        return [];
      }
      let baseUrl = DEFAULT_COPILOT_API_BASE_URL;
      let apiToken: string | undefined;
      try {
        const token = await resolveCopilotApiToken({ githubToken, env });
        baseUrl = token.baseUrl;
        apiToken = token.token;
      } catch {
        return [];
      }
      if (!apiToken) {
        return [];
      }
      const apiModels = await fetchCopilotModels(baseUrl, apiToken);
      const mapped = mapCopilotModels(apiModels);
      const newCache = new Map<string, MappedCopilotModelWithCapabilities>();
      for (const m of mapped) {
        newCache.set(m.id.toLowerCase(), m);
      }
      cachedModelCapabilities = newCache;
      return mapped;
    } finally {
      fetchModelsPromise = null;
    }
  })();
  return fetchModelsPromise;
}

type GithubCopilotPluginConfig = {
  discovery?: {
    enabled?: boolean;
  };
};

async function loadGithubCopilotRuntime() {
  return await import("./register.runtime.js");
}
export default definePluginEntry({
  id: "github-copilot",
  name: "GitHub Copilot Provider",
  description: "Bundled GitHub Copilot provider plugin",
  register(api) {
    const startupPluginConfig = (api.pluginConfig ?? {}) as GithubCopilotPluginConfig;

    function resolveCurrentPluginConfig(config?: OpenClawConfig): GithubCopilotPluginConfig {
      const runtimePluginConfig = resolvePluginConfigObject(config, "github-copilot");
      if (runtimePluginConfig) {
        return runtimePluginConfig as GithubCopilotPluginConfig;
      }
      return config ? {} : startupPluginConfig;
    }

    async function runGitHubCopilotAuth(ctx: ProviderAuthContext) {
      const { githubCopilotLoginCommand } = await loadGithubCopilotRuntime();
      await ctx.prompter.note(
        [
          "This will open a GitHub device login to authorize Copilot.",
          "Requires an active GitHub Copilot subscription.",
        ].join("\n"),
        "GitHub Copilot",
      );

      if (!process.stdin.isTTY) {
        await ctx.prompter.note(
          "GitHub Copilot login requires an interactive TTY.",
          "GitHub Copilot",
        );
        return { profiles: [] };
      }

      try {
        await githubCopilotLoginCommand(
          { yes: true, profileId: "github-copilot:github" },
          ctx.runtime,
        );
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
        defaultModel: "github-copilot/claude-opus-4.7",
      };
    }

    api.registerMemoryEmbeddingProvider(githubCopilotMemoryEmbeddingProviderAdapter);

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
          const pluginConfig = resolveCurrentPluginConfig(ctx.config);
          const discoveryEnabled =
            pluginConfig.discovery?.enabled ?? ctx.config?.models?.copilotDiscovery?.enabled;
          if (discoveryEnabled === false) {
            return null;
          }
          const { DEFAULT_COPILOT_API_BASE_URL, resolveCopilotApiToken } =
            await loadGithubCopilotRuntime();
          const { githubToken, hasProfile } = await resolveFirstGithubToken({
            agentDir: ctx.agentDir,
            config: ctx.config,
            env: ctx.env,
          });
          if (!hasProfile && !githubToken) {
            return null;
          }
          let baseUrl = DEFAULT_COPILOT_API_BASE_URL;
          let apiToken: string | undefined;
          if (githubToken) {
            try {
              const token = await resolveCopilotApiToken({
                githubToken,
                env: ctx.env,
              });
              baseUrl = token.baseUrl;
              apiToken = token.token;
            } catch {
              baseUrl = DEFAULT_COPILOT_API_BASE_URL;
            }
          }

          // Fetch models from Copilot API to get dynamic capabilities
          let catalogModels: MappedCopilotModelWithCapabilities[] = [];
          if (apiToken) {
            try {
              const apiModels = await fetchCopilotModels(baseUrl, apiToken);
              catalogModels = mapCopilotModels(apiModels);
              // Cache capabilities for thinking profile resolution
              const newCache = new Map<string, MappedCopilotModelWithCapabilities>();
              for (const m of catalogModels) {
                newCache.set(m.id.toLowerCase(), m);
              }
              cachedModelCapabilities = newCache;
            } catch {
              // Fall back to empty — resolveDynamicModel will handle unknown models
            }
          }

          return {
            provider: {
              baseUrl,
              // Strip internal _copilotCapabilities before returning to catalog
              models: catalogModels.map(({ _copilotCapabilities: _, ...model }) => model),
            },
          };
        },
      },
      resolveDynamicModel: (ctx) => resolveCopilotForwardCompatModel(ctx),
      prepareDynamicModel: async (ctx) => {
        // Lazily fetch model catalog from Copilot API when a model is requested
        // but not yet in the cache. This ensures dynamic models get API-sourced
        // capabilities even when catalog.run didn't execute during startup.
        if (cachedModelCapabilities.size > 0) {
          return;
        }
        try {
          await fetchAndCacheModels(ctx.config, process.env as NodeJS.ProcessEnv);
        } catch {
          // Silently skip — resolveDynamicModel fallback handles unknown models
        }
      },
      augmentModelCatalog: async (ctx) => {
        // Add dynamically-fetched Copilot models to the model catalog so they
        // appear in /models list. This runs during loadModelCatalog, after the
        // static model registry is loaded.
        try {
          const models = await fetchAndCacheModels(
            ctx.config,
            ctx.env ?? (process.env as NodeJS.ProcessEnv),
          );
          return models.map((m) => ({
            id: m.id,
            name: m.name,
            provider: PROVIDER_ID,
            contextWindow: m.contextWindow,
            reasoning: m.reasoning,
            input: m.input,
          }));
        } catch {
          return [];
        }
      },
      wrapStreamFn: wrapCopilotProviderStream,
      buildReplayPolicy: ({ modelId }) => buildGithubCopilotReplayPolicy(modelId),
      resolveThinkingProfile: ({ modelId }) => {
        const lower = normalizeOptionalLowercaseString(modelId) ?? "";
        const cached = cachedModelCapabilities.get(lower);
        if (cached?._copilotCapabilities) {
          return resolveThinkingProfileFromCapabilities(cached._copilotCapabilities);
        }
        // Fallback: basic heuristic when API data is not available
        return resolveThinkingProfileFromCapabilities(undefined);
      },
      prepareRuntimeAuth: async (ctx) => {
        const { resolveCopilotApiToken } = await loadGithubCopilotRuntime();
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
      fetchUsageSnapshot: async (ctx) => {
        const { fetchCopilotUsage } = await loadGithubCopilotRuntime();
        return await fetchCopilotUsage(ctx.token, ctx.timeoutMs, ctx.fetchFn);
      },
    });
  },
});
