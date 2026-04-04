import { formatCliCommand } from "openclaw/plugin-sdk/cli-runtime";
import type {
  OpenClawPluginApi,
  ProviderAuthContext,
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  CLAUDE_CLI_PROFILE_ID,
  applyAuthProfileConfig,
  ensureApiKeyFromOptionEnvOrPrompt,
  listProfilesForProvider,
  normalizeApiKeyInput,
  suggestOAuthProfileIdForLegacyDefault,
  type AuthProfileStore,
  type ProviderAuthResult,
  validateApiKeyInput,
} from "openclaw/plugin-sdk/provider-auth";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { cloneFirstTemplateModel } from "openclaw/plugin-sdk/provider-model-shared";
import { fetchClaudeUsage } from "openclaw/plugin-sdk/provider-usage";
import { buildAnthropicCliBackend } from "./cli-backend.js";
import { buildAnthropicCliMigrationResult, hasClaudeCliAuth } from "./cli-migration.js";
import {
  applyAnthropicConfigDefaults,
  normalizeAnthropicProviderConfig,
} from "./config-defaults.js";
import { anthropicMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { buildAnthropicReplayPolicy } from "./replay-policy.js";
import {
  wrapAnthropicProviderStream,
} from "./stream-wrappers.js";

const PROVIDER_ID = "anthropic";
const DEFAULT_ANTHROPIC_MODEL = "anthropic/claude-sonnet-4-6";
const ANTHROPIC_OPUS_46_MODEL_ID = "claude-opus-4-6";
const ANTHROPIC_OPUS_46_DOT_MODEL_ID = "claude-opus-4.6";
const ANTHROPIC_OPUS_TEMPLATE_MODEL_IDS = ["claude-opus-4-5", "claude-opus-4.5"] as const;
const ANTHROPIC_SONNET_46_MODEL_ID = "claude-sonnet-4-6";
const ANTHROPIC_SONNET_46_DOT_MODEL_ID = "claude-sonnet-4.6";
const ANTHROPIC_SONNET_TEMPLATE_MODEL_IDS = ["claude-sonnet-4-5", "claude-sonnet-4.5"] as const;
const ANTHROPIC_MODERN_MODEL_PREFIXES = [
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-opus-4-5",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
] as const;
const ANTHROPIC_OAUTH_ALLOWLIST = [
  "anthropic/claude-sonnet-4-6",
  "anthropic/claude-opus-4-6",
  "anthropic/claude-opus-4-5",
  "anthropic/claude-sonnet-4-5",
  "anthropic/claude-haiku-4-5",
] as const;

function resolveAnthropic46ForwardCompatModel(params: {
  ctx: ProviderResolveDynamicModelContext;
  dashModelId: string;
  dotModelId: string;
  dashTemplateId: string;
  dotTemplateId: string;
  fallbackTemplateIds: readonly string[];
}): ProviderRuntimeModel | undefined {
  const trimmedModelId = params.ctx.modelId.trim();
  const lower = trimmedModelId.toLowerCase();
  const is46Model =
    lower === params.dashModelId ||
    lower === params.dotModelId ||
    lower.startsWith(`${params.dashModelId}-`) ||
    lower.startsWith(`${params.dotModelId}-`);
  if (!is46Model) {
    return undefined;
  }

  const templateIds: string[] = [];
  if (lower.startsWith(params.dashModelId)) {
    templateIds.push(lower.replace(params.dashModelId, params.dashTemplateId));
  }
  if (lower.startsWith(params.dotModelId)) {
    templateIds.push(lower.replace(params.dotModelId, params.dotTemplateId));
  }
  templateIds.push(...params.fallbackTemplateIds);

  return cloneFirstTemplateModel({
    providerId: PROVIDER_ID,
    modelId: trimmedModelId,
    templateIds,
    ctx: params.ctx,
  });
}

function resolveAnthropicForwardCompatModel(
  ctx: ProviderResolveDynamicModelContext,
): ProviderRuntimeModel | undefined {
  return (
    resolveAnthropic46ForwardCompatModel({
      ctx,
      dashModelId: ANTHROPIC_OPUS_46_MODEL_ID,
      dotModelId: ANTHROPIC_OPUS_46_DOT_MODEL_ID,
      dashTemplateId: "claude-opus-4-5",
      dotTemplateId: "claude-opus-4.5",
      fallbackTemplateIds: ANTHROPIC_OPUS_TEMPLATE_MODEL_IDS,
    }) ??
    resolveAnthropic46ForwardCompatModel({
      ctx,
      dashModelId: ANTHROPIC_SONNET_46_MODEL_ID,
      dotModelId: ANTHROPIC_SONNET_46_DOT_MODEL_ID,
      dashTemplateId: "claude-sonnet-4-5",
      dotTemplateId: "claude-sonnet-4.5",
      fallbackTemplateIds: ANTHROPIC_SONNET_TEMPLATE_MODEL_IDS,
    })
  );
}

function matchesAnthropicModernModel(modelId: string): boolean {
  const lower = modelId.trim().toLowerCase();
  return ANTHROPIC_MODERN_MODEL_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function buildAnthropicAuthDoctorHint(params: {
  config?: ProviderAuthContext["config"];
  store: AuthProfileStore;
  profileId?: string;
}): string {
  const legacyProfileId = params.profileId ?? "anthropic:default";
  const suggested = suggestOAuthProfileIdForLegacyDefault({
    cfg: params.config,
    store: params.store,
    provider: PROVIDER_ID,
    legacyProfileId,
  });
  if (!suggested || suggested === legacyProfileId) {
    return "";
  }

  const storeOauthProfiles = listProfilesForProvider(params.store, PROVIDER_ID)
    .filter((id) => params.store.profiles[id]?.type === "oauth")
    .join(", ");

  const cfgMode = params.config?.auth?.profiles?.[legacyProfileId]?.mode;
  const cfgProvider = params.config?.auth?.profiles?.[legacyProfileId]?.provider;

  return [
    "Doctor hint (for GitHub issue):",
    `- provider: ${PROVIDER_ID}`,
    `- config: ${legacyProfileId}${
      cfgProvider || cfgMode ? ` (provider=${cfgProvider ?? "?"}, mode=${cfgMode ?? "?"})` : ""
    }`,
    `- auth store oauth profiles: ${storeOauthProfiles || "(none)"}`,
    `- suggested profile: ${suggested}`,
    `Fix: run "${formatCliCommand("openclaw doctor --yes")}"`,
  ].join("\n");
}

async function runAnthropicCliMigration(ctx: ProviderAuthContext): Promise<ProviderAuthResult> {
  if (!hasClaudeCliAuth()) {
    throw new Error(
      [
        "Claude CLI is not authenticated on this host.",
        `Run ${formatCliCommand("claude auth login")} first, then re-run this setup.`,
      ].join("\n"),
    );
  }
  return buildAnthropicCliMigrationResult(ctx.config);
}

async function runAnthropicCliMigrationNonInteractive(ctx: {
  config: ProviderAuthContext["config"];
  runtime: ProviderAuthContext["runtime"];
}): Promise<ProviderAuthContext["config"] | null> {
  if (!hasClaudeCliAuth()) {
    ctx.runtime.error(
      [
        'Auth choice "anthropic-cli" requires Claude CLI auth on this host.',
        `Run ${formatCliCommand("claude auth login")} first.`,
      ].join("\n"),
    );
    ctx.runtime.exit(1);
    return null;
  }

  const result = buildAnthropicCliMigrationResult(ctx.config);
  const currentDefaults = ctx.config.agents?.defaults;
  const currentModel = currentDefaults?.model;
  const currentFallbacks =
    currentModel && typeof currentModel === "object" && "fallbacks" in currentModel
      ? currentModel.fallbacks
      : undefined;

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
          ...(Array.isArray(currentFallbacks) ? { fallbacks: currentFallbacks } : {}),
          primary: result.defaultModel,
        },
      },
    },
  };
}

export async function registerAnthropicPlugin(api: OpenClawPluginApi): Promise<void> {
  // Be defensive against partially initialized module graphs during test/runtime bootstrap.
  const cliBackend =
    typeof buildAnthropicCliBackend === "function" ? buildAnthropicCliBackend() : undefined;
  if (cliBackend) {
    api.registerCliBackend(cliBackend);
  }
  api.registerProvider({
    id: PROVIDER_ID,
    label: "Anthropic",
    docsPath: "/providers/models",
    envVars: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
    deprecatedProfileIds: [CLAUDE_CLI_PROFILE_ID],
    oauthProfileIdRepairs: [
      {
        legacyProfileId: "anthropic:default",
        promptLabel: "Anthropic",
      },
    ],
    auth: [
      {
        id: "cli",
        label: "Claude CLI",
        hint: "Reuse a local Claude CLI login and switch model selection to claude-cli/*",
        kind: "custom",
        wizard: {
          choiceId: "anthropic-cli",
          choiceLabel: "Anthropic Claude CLI",
          choiceHint: "Reuse a local Claude CLI login on this host",
          assistantPriority: -20,
          groupId: "anthropic",
          groupLabel: "Anthropic",
          groupHint: "Claude CLI + API key",
          modelAllowlist: {
            allowedKeys: [...ANTHROPIC_OAUTH_ALLOWLIST].map((model) =>
              model.replace(/^anthropic\//, "claude-cli/"),
            ),
            initialSelections: ["claude-cli/claude-sonnet-4-6"],
            message: "Claude CLI models",
          },
        },
        run: async (ctx: ProviderAuthContext) => await runAnthropicCliMigration(ctx),
        runNonInteractive: async (ctx) =>
          await runAnthropicCliMigrationNonInteractive({
            config: ctx.config,
            runtime: ctx.runtime,
          }),
      },
      createProviderApiKeyAuthMethod({
        providerId: PROVIDER_ID,
        methodId: "api-key",
        label: "Anthropic API key",
        hint: "Direct Anthropic API key",
        optionKey: "anthropicApiKey",
        flagName: "--anthropic-api-key",
        envVar: "ANTHROPIC_API_KEY",
        promptMessage: "Enter Anthropic API key",
        defaultModel: DEFAULT_ANTHROPIC_MODEL,
        expectedProviders: ["anthropic"],
        wizard: {
          choiceId: "apiKey",
          choiceLabel: "Anthropic API key",
          groupId: "anthropic",
          groupLabel: "Anthropic",
          groupHint: "Claude CLI + API key",
        },
      }),
    ],
    normalizeConfig: ({ providerConfig }) => normalizeAnthropicProviderConfig(providerConfig),
    applyConfigDefaults: ({ config, env }) => applyAnthropicConfigDefaults({ config, env }),
    resolveDynamicModel: (ctx) => resolveAnthropicForwardCompatModel(ctx),
    buildReplayPolicy: (ctx) => buildAnthropicReplayPolicy(ctx),
    isModernModelRef: ({ modelId }) => matchesAnthropicModernModel(modelId),
    resolveReasoningOutputMode: () => "native",
    wrapStreamFn: (ctx) => wrapAnthropicProviderStream(ctx),
    resolveDefaultThinkingLevel: ({ modelId }) =>
      matchesAnthropicModernModel(modelId) &&
      (modelId.toLowerCase().startsWith(ANTHROPIC_OPUS_46_MODEL_ID) ||
        modelId.toLowerCase().startsWith(ANTHROPIC_OPUS_46_DOT_MODEL_ID) ||
        modelId.toLowerCase().startsWith(ANTHROPIC_SONNET_46_MODEL_ID) ||
        modelId.toLowerCase().startsWith(ANTHROPIC_SONNET_46_DOT_MODEL_ID))
        ? "adaptive"
        : undefined,
    resolveUsageAuth: async (ctx) => await ctx.resolveOAuthToken(),
    fetchUsageSnapshot: async (ctx) =>
      await fetchClaudeUsage(ctx.token, ctx.timeoutMs, ctx.fetchFn),
    isCacheTtlEligible: () => true,
    buildAuthDoctorHint: (ctx) =>
      buildAnthropicAuthDoctorHint({
        config: ctx.config,
        store: ctx.store,
        profileId: ctx.profileId,
      }),
  });
  api.registerMediaUnderstandingProvider(anthropicMediaUnderstandingProvider);
}
