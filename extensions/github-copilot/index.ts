import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import {
  definePluginEntry,
  type ProviderAuthContext,
  type ProviderAuthResult,
  type ProviderAuthMethodNonInteractiveContext,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  applyAuthProfileConfig,
  coerceSecretRef,
  ensureAuthProfileStore,
  listProfilesForProvider,
  normalizeOptionalSecretInput,
  resolveDefaultSecretProviderAlias,
  upsertAuthProfileWithLock,
} from "openclaw/plugin-sdk/provider-auth";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
import { resolveFirstGithubToken } from "./auth.js";
import { githubCopilotMemoryEmbeddingProviderAdapter } from "./embeddings.js";
import { PROVIDER_ID, resolveCopilotForwardCompatModel } from "./models.js";
import { buildGithubCopilotReplayPolicy } from "./replay-policy.js";
import { wrapCopilotProviderStream } from "./stream.js";

const COPILOT_ENV_VARS = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"];
const DEFAULT_COPILOT_MODEL = "github-copilot/claude-opus-4.7";
const DEFAULT_COPILOT_PROFILE_ID = "github-copilot:github";
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
    family?: unknown;
    type?: unknown;
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

  // Skip embedding-only entries: the Copilot /models endpoint also lists
  // embedding models (e.g. text-embedding-3-small) consumed by the embedding
  // provider. They expose /v1/embeddings (or no chat endpoints) and would
  // fail if surfaced as chat models in the catalog.
  const family = typeof entry.capabilities?.family === "string" ? entry.capabilities.family : "";
  const capabilityType =
    typeof entry.capabilities?.type === "string" ? entry.capabilities.type : "";
  const looksLikeEmbedding =
    /embedding/i.test(id) ||
    /embedding/i.test(family) ||
    capabilityType.toLowerCase() === "embeddings";
  const declaresEmbeddingEndpoint = endpoints.some((ep) => ep.toLowerCase().includes("embedding"));
  const declaresChatEndpoint = endpoints.some((ep) => {
    const lower = ep.toLowerCase();
    return (
      lower.includes("chat") ||
      lower.includes("responses") ||
      lower.includes("messages") ||
      lower.includes("completion")
    );
  });
  if (declaresEmbeddingEndpoint && !declaresChatEndpoint) {
    return null;
  }
  if (looksLikeEmbedding && !declaresChatEndpoint) {
    return null;
  }
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

  const payload = (await response.json()) as unknown;
  const models: unknown[] = Array.isArray(payload)
    ? payload
    : (() => {
        if (payload && typeof payload === "object") {
          const record = payload as { data?: unknown; models?: unknown };
          if (Array.isArray(record.data)) {
            return record.data;
          }
          if (Array.isArray(record.models)) {
            return record.models;
          }
        }
        return [];
      })();

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

function applyCopilotDefaultModel(cfg: OpenClawConfig): OpenClawConfig {
  const defaults = cfg.agents?.defaults;
  const existingModel = defaults?.model;
  const existingPrimary =
    typeof existingModel === "string"
      ? existingModel.trim()
      : typeof existingModel === "object" && typeof existingModel?.primary === "string"
        ? existingModel.primary.trim()
        : "";
  if (existingPrimary) {
    return cfg;
  }
  const fallbacks =
    typeof existingModel === "object" && existingModel !== null && "fallbacks" in existingModel
      ? (existingModel as { fallbacks?: string[] }).fallbacks
      : undefined;
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...defaults,
        model: {
          ...(fallbacks ? { fallbacks } : undefined),
          primary: DEFAULT_COPILOT_MODEL,
        },
        models: {
          ...defaults?.models,
          [DEFAULT_COPILOT_MODEL]: defaults?.models?.[DEFAULT_COPILOT_MODEL] ?? {},
        },
      },
    },
  };
}

function resolveExistingCopilotTokenProfileId(agentDir?: string): string | undefined {
  const authStore = ensureAuthProfileStore(agentDir, {
    allowKeychainPrompt: false,
  });
  return listProfilesForProvider(authStore, PROVIDER_ID).find((profileId) => {
    const profile = authStore.profiles[profileId];
    if (profile?.type !== "token") {
      return false;
    }
    return Boolean(
      normalizeOptionalSecretInput(profile.token) || coerceSecretRef(profile.tokenRef)?.id.trim(),
    );
  });
}

function resolveExistingCopilotAuthResult(agentDir?: string): ProviderAuthResult | null {
  const profileId = resolveExistingCopilotTokenProfileId(agentDir);
  if (!profileId) {
    return null;
  }
  const authStore = ensureAuthProfileStore(agentDir, {
    allowKeychainPrompt: false,
  });
  const credential = authStore.profiles[profileId];
  if (!credential || credential.type !== "token") {
    return null;
  }
  return {
    profiles: [
      {
        profileId,
        credential,
      },
    ],
    defaultModel: DEFAULT_COPILOT_MODEL,
  };
}

async function resolveCopilotNonInteractiveToken(
  ctx: ProviderAuthMethodNonInteractiveContext,
  flagValue: string | undefined,
) {
  const resolveFromEnvChain = async () => {
    for (const envVar of COPILOT_ENV_VARS) {
      const resolved = await ctx.resolveApiKey({
        provider: PROVIDER_ID,
        flagName: "--github-copilot-token",
        envVar,
        envVarName: envVar,
        allowProfile: false,
        required: false,
      });
      if (resolved) {
        return resolved;
      }
    }
    return null;
  };

  if (ctx.opts.secretInputMode === "ref") {
    const resolved = await resolveFromEnvChain();
    if (resolved) {
      return resolved;
    }
    if (flagValue) {
      ctx.runtime.error(
        [
          "--github-copilot-token cannot be used with --secret-input-mode ref unless COPILOT_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN is set in env.",
          "Set one of those env vars and omit --github-copilot-token, or use --secret-input-mode plaintext.",
        ].join("\n"),
      );
      ctx.runtime.exit(1);
    }
    return null;
  }

  const primary = await ctx.resolveApiKey({
    provider: PROVIDER_ID,
    flagValue,
    flagName: "--github-copilot-token",
    envVar: COPILOT_ENV_VARS[0],
    envVarName: COPILOT_ENV_VARS[0],
    allowProfile: false,
    required: false,
  });
  if (primary || flagValue) {
    return primary;
  }

  for (const envVar of COPILOT_ENV_VARS.slice(1)) {
    const resolved = await ctx.resolveApiKey({
      provider: PROVIDER_ID,
      flagName: "--github-copilot-token",
      envVar,
      envVarName: envVar,
      allowProfile: false,
      required: false,
    });
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

async function runGitHubCopilotNonInteractiveAuth(
  ctx: ProviderAuthMethodNonInteractiveContext,
): Promise<OpenClawConfig | null> {
  const opts = ctx.opts as Record<string, unknown> | undefined;
  const flagValue = normalizeOptionalSecretInput(opts?.githubCopilotToken);
  const resolved = await resolveCopilotNonInteractiveToken(ctx, flagValue);

  let profileId = DEFAULT_COPILOT_PROFILE_ID;
  if (resolved) {
    const useTokenRef = ctx.opts.secretInputMode === "ref" && resolved.source === "env";
    if (useTokenRef && !resolved.envVarName) {
      ctx.runtime.error(
        [
          '--secret-input-mode ref requires an explicit environment variable for provider "github-copilot".',
          "Set COPILOT_GITHUB_TOKEN in env and retry, or use --secret-input-mode plaintext.",
        ].join("\n"),
      );
      ctx.runtime.exit(1);
      return null;
    }
    await upsertAuthProfileWithLock({
      profileId,
      credential: {
        type: "token",
        provider: PROVIDER_ID,
        ...(useTokenRef
          ? {
              tokenRef: {
                source: "env",
                provider: resolveDefaultSecretProviderAlias(ctx.baseConfig, "env", {
                  preferFirstProviderForSource: true,
                }),
                id: resolved.envVarName!,
              },
            }
          : { token: resolved.key }),
      },
      agentDir: ctx.agentDir,
    });
  } else {
    if (flagValue && ctx.opts.secretInputMode === "ref") {
      return null;
    }
    const existingProfileId = resolveExistingCopilotTokenProfileId(ctx.agentDir);
    if (!existingProfileId) {
      ctx.runtime.error(
        "Missing --github-copilot-token (or COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN env var) for --auth-choice github-copilot.",
      );
      ctx.runtime.exit(1);
      return null;
    }
    profileId = existingProfileId;
  }

  return applyCopilotDefaultModel(
    applyAuthProfileConfig(ctx.config, {
      profileId,
      provider: PROVIDER_ID,
      mode: "token",
    }),
  );
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
      const existing = resolveExistingCopilotAuthResult(ctx.agentDir);
      if (existing) {
        const runLogin = await ctx.prompter.confirm({
          message: "GitHub Copilot auth already exists. Re-run login?",
          initialValue: false,
        });
        if (!runLogin) {
          return existing;
        }
      }

      await ctx.prompter.note(
        [
          "This will open a GitHub device login to authorize Copilot.",
          "Requires an active GitHub Copilot subscription.",
        ].join("\n"),
        "GitHub Copilot",
      );

      const { runGitHubCopilotDeviceFlow } = await import("./login.js");

      const result = await runGitHubCopilotDeviceFlow({
        showCode: async ({ verificationUrl, userCode, expiresInMs }) => {
          const expiresInMinutes = Math.max(1, Math.round(expiresInMs / 60_000));
          await ctx.prompter.note(
            [
              "Open this URL in your browser and enter the code below.",
              `URL: ${verificationUrl}`,
              `Code: ${userCode}`,
              `Code expires in ${expiresInMinutes} minutes. Never share it.`,
              "",
              "If a browser does not open automatically after you continue, copy the URL manually.",
            ].join("\n"),
            "Authorize GitHub Copilot",
          );
        },
        openUrl: async (url) => {
          await ctx.openUrl(url);
        },
      });

      if (result.status === "access_denied") {
        await ctx.prompter.note("GitHub Copilot login was cancelled.", "GitHub Copilot");
        return { profiles: [] };
      }

      if (result.status === "expired") {
        await ctx.prompter.note(
          "The GitHub device code expired. Retry login to get a new code.",
          "GitHub Copilot",
        );
        return { profiles: [] };
      }

      return {
        profiles: [
          {
            profileId: DEFAULT_COPILOT_PROFILE_ID,
            credential: {
              type: "token" as const,
              provider: PROVIDER_ID,
              token: result.accessToken,
            },
          },
        ],
        defaultModel: DEFAULT_COPILOT_MODEL,
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
          runNonInteractive: async (ctx) => await runGitHubCopilotNonInteractiveAuth(ctx),
        },
      ],
      wizard: {
        setup: {
          choiceId: "github-copilot",
          choiceLabel: "GitHub Copilot",
          choiceHint: "Device login with your GitHub account",
          methodId: "device",
          modelSelection: {
            promptWhenAuthChoiceProvided: true,
          },
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
