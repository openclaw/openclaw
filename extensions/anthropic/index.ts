import {
  emptyPluginConfigSchema,
  type OpenClawPluginApi,
  type ProviderAuthContext,
  type ProviderResolveDynamicModelContext,
  type ProviderRuntimeModel,
} from "openclaw/plugin-sdk/core";
import { upsertAuthProfile } from "../../src/agents/auth-profiles.js";
import { normalizeModelCompat } from "../../src/agents/model-compat.js";
import { parseDurationMs } from "../../src/cli/parse-duration.js";
import {
  normalizeSecretInputModeInput,
  promptSecretRefForSetup,
  resolveSecretInputModeForEnvSelection,
} from "../../src/commands/auth-choice.apply-helpers.js";
import { buildTokenProfileId, validateAnthropicSetupToken } from "../../src/commands/auth-token.js";
import { applyAuthProfileConfig } from "../../src/commands/onboard-auth.js";
import { fetchClaudeUsage } from "../../src/infra/provider-usage.fetch.js";
import type { ProviderAuthResult } from "../../src/plugins/types.js";
import { normalizeSecretInput } from "../../src/utils/normalize-secret-input.js";

const PROVIDER_ID = "anthropic";
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

function cloneFirstTemplateModel(params: {
  modelId: string;
  templateIds: readonly string[];
  ctx: ProviderResolveDynamicModelContext;
}): ProviderRuntimeModel | undefined {
  const trimmedModelId = params.modelId.trim();
  for (const templateId of [...new Set(params.templateIds)].filter(Boolean)) {
    const template = params.ctx.modelRegistry.find(
      PROVIDER_ID,
      templateId,
    ) as ProviderRuntimeModel | null;
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

async function runAnthropicSetupToken(ctx: ProviderAuthContext): Promise<ProviderAuthResult> {
  await ctx.prompter.note(
    ["Run `claude setup-token` in your terminal.", "Then paste the generated token below."].join(
      "\n",
    ),
    "Anthropic setup-token",
  );

  const requestedSecretInputMode = normalizeSecretInputModeInput(ctx.secretInputMode);
  const selectedMode = ctx.allowSecretRefPrompt
    ? await resolveSecretInputModeForEnvSelection({
        prompter: ctx.prompter,
        explicitMode: requestedSecretInputMode,
        copy: {
          modeMessage: "How do you want to provide this setup token?",
          plaintextLabel: "Paste setup token now",
          plaintextHint: "Stores the token directly in the auth profile",
        },
      })
    : "plaintext";

  let token = "";
  let tokenRef: { source: "env" | "file" | "exec"; provider: string; id: string } | undefined;
  if (selectedMode === "ref") {
    const resolved = await promptSecretRefForSetup({
      provider: "anthropic-setup-token",
      config: ctx.config,
      prompter: ctx.prompter,
      preferredEnvVar: "ANTHROPIC_SETUP_TOKEN",
      copy: {
        sourceMessage: "Where is this Anthropic setup token stored?",
        envVarPlaceholder: "ANTHROPIC_SETUP_TOKEN",
      },
    });
    token = resolved.resolvedValue.trim();
    tokenRef = resolved.ref;
  } else {
    const tokenRaw = await ctx.prompter.text({
      message: "Paste Anthropic setup-token",
      validate: (value) => validateAnthropicSetupToken(String(value ?? "")),
    });
    token = String(tokenRaw ?? "").trim();
  }
  const tokenError = validateAnthropicSetupToken(token);
  if (tokenError) {
    throw new Error(tokenError);
  }

  const profileNameRaw = await ctx.prompter.text({
    message: "Token name (blank = default)",
    placeholder: "default",
  });

  return {
    profiles: [
      {
        profileId: buildTokenProfileId({
          provider: PROVIDER_ID,
          name: String(profileNameRaw ?? ""),
        }),
        credential: {
          type: "token",
          provider: PROVIDER_ID,
          token,
          ...(tokenRef ? { tokenRef } : {}),
        },
      },
    ],
  };
}

async function runAnthropicSetupTokenNonInteractive(ctx: {
  config: ProviderAuthContext["config"];
  opts: {
    tokenProvider?: string;
    token?: string;
    tokenExpiresIn?: string;
    tokenProfileId?: string;
  };
  runtime: ProviderAuthContext["runtime"];
  agentDir?: string;
}): Promise<ProviderAuthContext["config"] | null> {
  const provider = ctx.opts.tokenProvider?.trim().toLowerCase();
  if (!provider) {
    ctx.runtime.error("Missing --token-provider for --auth-choice token.");
    ctx.runtime.exit(1);
    return null;
  }
  if (provider !== PROVIDER_ID) {
    ctx.runtime.error("Only --token-provider anthropic is supported for --auth-choice token.");
    ctx.runtime.exit(1);
    return null;
  }

  const token = normalizeSecretInput(ctx.opts.token);
  if (!token) {
    ctx.runtime.error("Missing --token for --auth-choice token.");
    ctx.runtime.exit(1);
    return null;
  }
  const tokenError = validateAnthropicSetupToken(token);
  if (tokenError) {
    ctx.runtime.error(tokenError);
    ctx.runtime.exit(1);
    return null;
  }

  let expires: number | undefined;
  const expiresInRaw = ctx.opts.tokenExpiresIn?.trim();
  if (expiresInRaw) {
    try {
      expires = Date.now() + parseDurationMs(expiresInRaw, { defaultUnit: "d" });
    } catch (err) {
      ctx.runtime.error(`Invalid --token-expires-in: ${String(err)}`);
      ctx.runtime.exit(1);
      return null;
    }
  }

  const profileId =
    ctx.opts.tokenProfileId?.trim() || buildTokenProfileId({ provider: PROVIDER_ID, name: "" });
  upsertAuthProfile({
    profileId,
    agentDir: ctx.agentDir,
    credential: {
      type: "token",
      provider: PROVIDER_ID,
      token,
      ...(expires ? { expires } : {}),
    },
  });
  return applyAuthProfileConfig(ctx.config, {
    profileId,
    provider: PROVIDER_ID,
    mode: "token",
  });
}

const anthropicPlugin = {
  id: PROVIDER_ID,
  name: "Anthropic Provider",
  description: "Bundled Anthropic provider plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Anthropic",
      docsPath: "/providers/models",
      envVars: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
      auth: [
        {
          id: "setup-token",
          label: "setup-token (claude)",
          hint: "Paste a setup-token from `claude setup-token`",
          kind: "token",
          run: async (ctx: ProviderAuthContext) => await runAnthropicSetupToken(ctx),
          runNonInteractive: async (ctx) =>
            await runAnthropicSetupTokenNonInteractive({
              config: ctx.config,
              opts: ctx.opts,
              runtime: ctx.runtime,
              agentDir: ctx.agentDir,
            }),
        },
      ],
      wizard: {
        setup: {
          choiceId: "token",
          choiceLabel: "Anthropic token (paste setup-token)",
          choiceHint: "Run `claude setup-token` elsewhere, then paste the token here",
          methodId: "setup-token",
        },
      },
      resolveDynamicModel: (ctx) => resolveAnthropicForwardCompatModel(ctx),
      capabilities: {
        providerFamily: "anthropic",
        dropThinkingBlockModelHints: ["claude"],
      },
      isModernModelRef: ({ modelId }) => matchesAnthropicModernModel(modelId),
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
    });
  },
};

export default anthropicPlugin;
