import {
  emptyPluginConfigSchema,
  type OpenClawPluginApi,
  type ProviderAuthContext,
  type ProviderResolveDynamicModelContext,
  type ProviderRuntimeModel,
} from "openclaw/plugin-sdk/core";
import { normalizeModelCompat } from "../../src/agents/model-compat.js";
import { buildTokenProfileId, validateAnthropicSetupToken } from "../../src/commands/auth-token.js";
import { fetchClaudeUsage } from "../../src/infra/provider-usage.fetch.js";
import type { ProviderAuthResult } from "../../src/plugins/types.js";

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

  const tokenRaw = await ctx.prompter.text({
    message: "Paste Anthropic setup-token",
    validate: (value) => validateAnthropicSetupToken(String(value ?? "")),
  });
  const token = String(tokenRaw ?? "").trim();
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
        },
      },
    ],
  };
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
        },
      ],
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
