import {
  emptyPluginConfigSchema,
  type OpenClawPluginApi,
  type ProviderResolveDynamicModelContext,
  type ProviderRuntimeModel,
} from "openclaw/plugin-sdk/core";
import { listProfilesForProvider } from "../../src/agents/auth-profiles/profiles.js";
import { ensureAuthProfileStore } from "../../src/agents/auth-profiles/store.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../src/agents/defaults.js";
import { normalizeModelCompat } from "../../src/agents/model-compat.js";
import { normalizeProviderId } from "../../src/agents/model-selection.js";
import { buildOpenAICodexProvider } from "../../src/agents/models-config.providers.static.js";

const PROVIDER_ID = "openai-codex";
const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const OPENAI_CODEX_GPT_54_MODEL_ID = "gpt-5.4";
const OPENAI_CODEX_GPT_54_CONTEXT_TOKENS = 1_050_000;
const OPENAI_CODEX_GPT_54_MAX_TOKENS = 128_000;
const OPENAI_CODEX_GPT_54_TEMPLATE_MODEL_IDS = ["gpt-5.3-codex", "gpt-5.2-codex"] as const;
const OPENAI_CODEX_GPT_53_MODEL_ID = "gpt-5.3-codex";
const OPENAI_CODEX_GPT_53_SPARK_MODEL_ID = "gpt-5.3-codex-spark";
const OPENAI_CODEX_GPT_53_SPARK_CONTEXT_TOKENS = 128_000;
const OPENAI_CODEX_GPT_53_SPARK_MAX_TOKENS = 128_000;
const OPENAI_CODEX_TEMPLATE_MODEL_IDS = ["gpt-5.2-codex"] as const;

function isOpenAIApiBaseUrl(baseUrl?: string): boolean {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return false;
  }
  return /^https?:\/\/api\.openai\.com(?:\/v1)?\/?$/i.test(trimmed);
}

function isOpenAICodexBaseUrl(baseUrl?: string): boolean {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return false;
  }
  return /^https?:\/\/chatgpt\.com\/backend-api\/?$/i.test(trimmed);
}

function normalizeCodexTransport(model: ProviderRuntimeModel): ProviderRuntimeModel {
  const useCodexTransport =
    !model.baseUrl || isOpenAIApiBaseUrl(model.baseUrl) || isOpenAICodexBaseUrl(model.baseUrl);
  const api =
    useCodexTransport && model.api === "openai-responses" ? "openai-codex-responses" : model.api;
  const baseUrl =
    api === "openai-codex-responses" && (!model.baseUrl || isOpenAIApiBaseUrl(model.baseUrl))
      ? OPENAI_CODEX_BASE_URL
      : model.baseUrl;
  if (api === model.api && baseUrl === model.baseUrl) {
    return model;
  }
  return {
    ...model,
    api,
    baseUrl,
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

function resolveCodexForwardCompatModel(
  ctx: ProviderResolveDynamicModelContext,
): ProviderRuntimeModel | undefined {
  const trimmedModelId = ctx.modelId.trim();
  const lower = trimmedModelId.toLowerCase();

  let templateIds: readonly string[];
  let patch: Partial<ProviderRuntimeModel> | undefined;
  if (lower === OPENAI_CODEX_GPT_54_MODEL_ID) {
    templateIds = OPENAI_CODEX_GPT_54_TEMPLATE_MODEL_IDS;
    patch = {
      contextWindow: OPENAI_CODEX_GPT_54_CONTEXT_TOKENS,
      maxTokens: OPENAI_CODEX_GPT_54_MAX_TOKENS,
    };
  } else if (lower === OPENAI_CODEX_GPT_53_SPARK_MODEL_ID) {
    templateIds = [OPENAI_CODEX_GPT_53_MODEL_ID, ...OPENAI_CODEX_TEMPLATE_MODEL_IDS];
    patch = {
      api: "openai-codex-responses",
      provider: PROVIDER_ID,
      baseUrl: OPENAI_CODEX_BASE_URL,
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: OPENAI_CODEX_GPT_53_SPARK_CONTEXT_TOKENS,
      maxTokens: OPENAI_CODEX_GPT_53_SPARK_MAX_TOKENS,
    };
  } else if (lower === OPENAI_CODEX_GPT_53_MODEL_ID) {
    templateIds = OPENAI_CODEX_TEMPLATE_MODEL_IDS;
  } else {
    return undefined;
  }

  return (
    cloneFirstTemplateModel({
      modelId: trimmedModelId,
      templateIds,
      ctx,
      patch,
    }) ??
    normalizeModelCompat({
      id: trimmedModelId,
      name: trimmedModelId,
      api: "openai-codex-responses",
      provider: PROVIDER_ID,
      baseUrl: OPENAI_CODEX_BASE_URL,
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: patch?.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
      maxTokens: patch?.maxTokens ?? DEFAULT_CONTEXT_TOKENS,
    } as ProviderRuntimeModel)
  );
}

const openAICodexPlugin = {
  id: "openai-codex",
  name: "OpenAI Codex Provider",
  description: "Bundled OpenAI Codex provider plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "OpenAI Codex",
      docsPath: "/providers/models",
      auth: [],
      catalog: {
        order: "profile",
        run: async (ctx) => {
          const authStore = ensureAuthProfileStore(ctx.agentDir, {
            allowKeychainPrompt: false,
          });
          if (listProfilesForProvider(authStore, PROVIDER_ID).length === 0) {
            return null;
          }
          return {
            provider: buildOpenAICodexProvider(),
          };
        },
      },
      resolveDynamicModel: (ctx) => resolveCodexForwardCompatModel(ctx),
      capabilities: {
        providerFamily: "openai",
      },
      prepareExtraParams: (ctx) => {
        const transport = ctx.extraParams?.transport;
        if (transport === "auto" || transport === "sse" || transport === "websocket") {
          return ctx.extraParams;
        }
        return {
          ...ctx.extraParams,
          transport: "auto",
        };
      },
      normalizeResolvedModel: (ctx) => {
        if (normalizeProviderId(ctx.provider) !== PROVIDER_ID) {
          return undefined;
        }
        return normalizeCodexTransport(ctx.model);
      },
    });
  },
};

export default openAICodexPlugin;
