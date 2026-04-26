import { resolvePluginConfigObject, type OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { definePluginEntry, type ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import { ensureAuthProfileStore } from "openclaw/plugin-sdk/provider-auth";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
import { resolveFirstGithubToken } from "./auth.js";
import { githubCopilotMemoryEmbeddingProviderAdapter } from "./embeddings.js";
import { PROVIDER_ID, resolveCopilotForwardCompatModel } from "./models.js";
import { buildGithubCopilotReplayPolicy } from "./replay-policy.js";
import { wrapCopilotProviderStream } from "./stream.js";

const COPILOT_ENV_VARS = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"];
const COPILOT_XHIGH_MODEL_IDS = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.3-codex",
  "gpt-5.2",
  "gpt-5.2-codex",
] as const;

type CopilotModelWireEntry = {
  id?: unknown;
  model?: unknown;
  name?: unknown;
  capabilities?: {
    limits?: {
      max_context_window_tokens?: unknown;
      max_output_tokens?: unknown;
      vision?: unknown;
    };
    supports?: {
      reasoning_effort?: unknown;
      vision?: unknown;
    };
  };
  supported_endpoints?: unknown;
};

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function isAnthropicMessagesEndpoint(endpoint: string): boolean {
  const normalized = endpoint.trim().toLowerCase();
  return (
    normalized === "/messages" ||
    normalized.endsWith("/messages") ||
    normalized.includes("anthropic")
  );
}

export function mapCopilotWireModel(entry: CopilotModelWireEntry): ModelDefinitionConfig | null {
  const id =
    typeof entry.id === "string" && entry.id.trim()
      ? entry.id.trim()
      : typeof entry.model === "string" && entry.model.trim()
        ? entry.model.trim()
        : "";
  if (!id) {
    return null;
  }

  const limits = entry.capabilities?.limits ?? {};
  const supports = entry.capabilities?.supports ?? {};
  const endpoints = Array.isArray(entry.supported_endpoints)
    ? entry.supported_endpoints.filter(
        (endpoint): endpoint is string => typeof endpoint === "string",
      )
    : [];
  const reasoningEfforts = Array.isArray(supports.reasoning_effort)
    ? supports.reasoning_effort
    : [];

  const contextWindow = positiveInteger(limits.max_context_window_tokens) ?? 128_000;
  const maxTokens = positiveInteger(limits.max_output_tokens) ?? 8192;
  const supportsVision = supports.vision === true || Boolean(limits.vision);
  const supportsReasoning = reasoningEfforts.some(
    (level) => typeof level === "string" && level.trim().toLowerCase() !== "none",
  );

  return {
    id,
    name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : id,
    api: endpoints.some(isAnthropicMessagesEndpoint) ? "anthropic-messages" : "openai-responses",
    reasoning: supportsReasoning,
    input: supportsVision ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
    metadataSource: "models-add",
  };
}

async function fetchCopilotModelCatalog(params: {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<ModelDefinitionConfig[]> {
  const response = await (params.fetchImpl ?? fetch)(
    `${params.baseUrl.replace(/\/+$/, "")}/models`,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${params.token}`,
        "Copilot-Integration-Id": "vscode-chat",
        "Editor-Plugin-Version": "copilot-chat/0.35.0",
        "Editor-Version": "vscode/1.96.2",
        "User-Agent": "GitHubCopilotChat/0.26.7",
      },
      ...(params.timeoutMs ? { signal: AbortSignal.timeout(params.timeoutMs) } : {}),
    },
  );
  if (!response.ok) {
    return [];
  }

  const payload = (await response.json()) as { data?: unknown; models?: unknown } | unknown[];
  const models = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.data)
      ? payload.data
      : Array.isArray(payload.models)
        ? payload.models
        : [];

  return models
    .map((entry) => mapCopilotWireModel(entry as CopilotModelWireEntry))
    .filter((entry): entry is ModelDefinitionConfig => entry !== null);
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
          let apiToken = "";
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
          const models = apiToken
            ? await fetchCopilotModelCatalog({
                baseUrl,
                token: apiToken,
                timeoutMs: 10_000,
              }).catch(() => [])
            : [];
          return {
            provider: {
              baseUrl,
              models,
            },
          };
        },
      },
      resolveDynamicModel: (ctx) => resolveCopilotForwardCompatModel(ctx),
      wrapStreamFn: wrapCopilotProviderStream,
      buildReplayPolicy: ({ modelId }) => buildGithubCopilotReplayPolicy(modelId),
      resolveThinkingProfile: ({ modelId }) => ({
        levels: [
          { id: "off" },
          { id: "minimal" },
          { id: "low" },
          { id: "medium" },
          { id: "high" },
          ...(COPILOT_XHIGH_MODEL_IDS.includes(
            (normalizeOptionalLowercaseString(modelId) ?? "") as never,
          )
            ? [{ id: "xhigh" as const }]
            : []),
        ],
      }),
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
