import {
  emptyPluginConfigSchema,
  type OpenClawPluginApi,
  type ProviderResolveDynamicModelContext,
  type ProviderRuntimeModel,
} from "openclaw/plugin-sdk/core";
import { DEFAULT_CONTEXT_TOKENS } from "../../src/agents/defaults.js";
import { normalizeModelCompat } from "../../src/agents/model-compat.js";
import { normalizeProviderId } from "../../src/agents/model-selection.js";

const PROVIDER_ID = "openai";
const OPENAI_BASE_URL = "https://api.openai.com/v1";
const OPENAI_GPT_54_MODEL_ID = "gpt-5.4";
const OPENAI_GPT_54_PRO_MODEL_ID = "gpt-5.4-pro";
const OPENAI_GPT_54_CONTEXT_TOKENS = 1_050_000;
const OPENAI_GPT_54_MAX_TOKENS = 128_000;
const OPENAI_GPT_54_TEMPLATE_MODEL_IDS = ["gpt-5.2"] as const;
const OPENAI_GPT_54_PRO_TEMPLATE_MODEL_IDS = ["gpt-5.2-pro", "gpt-5.2"] as const;

function isOpenAIApiBaseUrl(baseUrl?: string): boolean {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return false;
  }
  return /^https?:\/\/api\.openai\.com(?:\/v1)?\/?$/i.test(trimmed);
}

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

function cloneFirstTemplateModel(params: {
  modelId: string;
  templateIds: readonly string[];
  ctx: ProviderResolveDynamicModelContext;
  patch?: Partial<ProviderRuntimeModel>;
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
      ...params.patch,
    } as ProviderRuntimeModel);
  }
  return undefined;
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
      modelId: trimmedModelId,
      templateIds,
      ctx,
      patch: {
        api: "openai-responses",
        provider: PROVIDER_ID,
        baseUrl: OPENAI_BASE_URL,
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
      baseUrl: OPENAI_BASE_URL,
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: OPENAI_GPT_54_CONTEXT_TOKENS,
      maxTokens: OPENAI_GPT_54_MAX_TOKENS,
    } as ProviderRuntimeModel)
  );
}

const openAIPlugin = {
  id: PROVIDER_ID,
  name: "OpenAI Provider",
  description: "Bundled OpenAI provider plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
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
    });
  },
};

export default openAIPlugin;
