import {
  type ProviderResolveDynamicModelContext,
  type ProviderRuntimeModel,
} from "openclaw/plugin-sdk/core";
import { normalizeModelCompat } from "../../src/agents/model-compat.js";
import { normalizeProviderId } from "../../src/agents/model-selection.js";
import type { ProviderPlugin } from "../../src/plugins/types.js";
import {
  cloneFirstTemplateModel,
  findCatalogTemplate,
  isOpenAIApiBaseUrl,
  matchesExactOrPrefix,
} from "./shared.js";

const PROVIDER_ID = "openai";
const OPENAI_GPT_54_MODEL_ID = "gpt-5.4";
const OPENAI_GPT_54_PRO_MODEL_ID = "gpt-5.4-pro";
const OPENAI_GPT_54_CONTEXT_TOKENS = 1_050_000;
const OPENAI_GPT_54_MAX_TOKENS = 128_000;
const OPENAI_GPT_54_TEMPLATE_MODEL_IDS = ["gpt-5.2"] as const;
const OPENAI_GPT_54_PRO_TEMPLATE_MODEL_IDS = ["gpt-5.2-pro", "gpt-5.2"] as const;
const OPENAI_XHIGH_MODEL_IDS = ["gpt-5.4", "gpt-5.4-pro", "gpt-5.2"] as const;
const OPENAI_MODERN_MODEL_IDS = ["gpt-5.4", "gpt-5.4-pro", "gpt-5.2", "gpt-5.0"] as const;
const OPENAI_DIRECT_SPARK_MODEL_ID = "gpt-5.3-codex-spark";
const SUPPRESSED_SPARK_PROVIDERS = new Set(["openai", "azure-openai-responses"]);

function normalizeOpenAITransport(model: ProviderRuntimeModel): ProviderRuntimeModel {
  const useResponsesTransport =
    model.api === "openai-completions" && (!model.baseUrl || isOpenAIApiBaseUrl(model.baseUrl));

  if (!useResponsesTransport) {
    return model;
  }

  return {
    ...model,
    api: "openai-responses",
  };
}

function resolveOpenAIGpt54ForwardCompatModel(
  ctx: ProviderResolveDynamicModelContext,
): ProviderRuntimeModel | undefined {
  const trimmedModelId = ctx.modelId.trim();
  const lower = trimmedModelId.toLowerCase();
  let templateIds: readonly string[];
  if (lower === OPENAI_GPT_54_MODEL_ID) {
    templateIds = OPENAI_GPT_54_TEMPLATE_MODEL_IDS;
  } else if (lower === OPENAI_GPT_54_PRO_MODEL_ID) {
    templateIds = OPENAI_GPT_54_PRO_TEMPLATE_MODEL_IDS;
  } else {
    return undefined;
  }

  return (
    cloneFirstTemplateModel({
      providerId: PROVIDER_ID,
      modelId: trimmedModelId,
      templateIds,
      ctx,
      patch: {
        api: "openai-responses",
        provider: PROVIDER_ID,
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: OPENAI_GPT_54_CONTEXT_TOKENS,
        maxTokens: OPENAI_GPT_54_MAX_TOKENS,
      },
    }) ??
    normalizeModelCompat({
      id: trimmedModelId,
      name: trimmedModelId,
      api: "openai-responses",
      provider: PROVIDER_ID,
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: OPENAI_GPT_54_CONTEXT_TOKENS,
      maxTokens: OPENAI_GPT_54_MAX_TOKENS,
    } as ProviderRuntimeModel)
  );
}

export function buildOpenAIProvider(): ProviderPlugin {
  return {
    id: PROVIDER_ID,
    label: "OpenAI",
    docsPath: "/providers/models",
    envVars: ["OPENAI_API_KEY"],
    auth: [],
    resolveDynamicModel: (ctx) => resolveOpenAIGpt54ForwardCompatModel(ctx),
    normalizeResolvedModel: (ctx) => {
      if (normalizeProviderId(ctx.provider) !== PROVIDER_ID) {
        return undefined;
      }
      return normalizeOpenAITransport(ctx.model);
    },
    capabilities: {
      providerFamily: "openai",
    },
    supportsXHighThinking: ({ modelId }) => matchesExactOrPrefix(modelId, OPENAI_XHIGH_MODEL_IDS),
    isModernModelRef: ({ modelId }) => matchesExactOrPrefix(modelId, OPENAI_MODERN_MODEL_IDS),
    buildMissingAuthMessage: (ctx) => {
      if (ctx.provider !== PROVIDER_ID || ctx.listProfileIds("openai-codex").length === 0) {
        return undefined;
      }
      return 'No API key found for provider "openai". You are authenticated with OpenAI Codex OAuth. Use openai-codex/gpt-5.4 (OAuth) or set OPENAI_API_KEY to use openai/gpt-5.4.';
    },
    suppressBuiltInModel: (ctx) => {
      if (
        !SUPPRESSED_SPARK_PROVIDERS.has(normalizeProviderId(ctx.provider)) ||
        ctx.modelId.toLowerCase() !== OPENAI_DIRECT_SPARK_MODEL_ID
      ) {
        return undefined;
      }
      return {
        suppress: true,
        errorMessage: `Unknown model: ${ctx.provider}/${OPENAI_DIRECT_SPARK_MODEL_ID}. ${OPENAI_DIRECT_SPARK_MODEL_ID} is only supported via openai-codex OAuth. Use openai-codex/${OPENAI_DIRECT_SPARK_MODEL_ID}.`,
      };
    },
    augmentModelCatalog: (ctx) => {
      const openAiGpt54Template = findCatalogTemplate({
        entries: ctx.entries,
        providerId: PROVIDER_ID,
        templateIds: OPENAI_GPT_54_TEMPLATE_MODEL_IDS,
      });
      const openAiGpt54ProTemplate = findCatalogTemplate({
        entries: ctx.entries,
        providerId: PROVIDER_ID,
        templateIds: OPENAI_GPT_54_PRO_TEMPLATE_MODEL_IDS,
      });
      return [
        openAiGpt54Template
          ? {
              ...openAiGpt54Template,
              id: OPENAI_GPT_54_MODEL_ID,
              name: OPENAI_GPT_54_MODEL_ID,
            }
          : undefined,
        openAiGpt54ProTemplate
          ? {
              ...openAiGpt54ProTemplate,
              id: OPENAI_GPT_54_PRO_MODEL_ID,
              name: OPENAI_GPT_54_PRO_MODEL_ID,
            }
          : undefined,
      ].filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
    },
  };
}
