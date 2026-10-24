// Provider-runtime mock used by model resolution tests.
import { lowercasePreservingWhitespace } from "@openclaw/normalization-core/string-coerce";
import type { ModelProviderAuthMode } from "../../config/types.js";

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const OPENAI_CODEX_LEGACY_BASE_URL = "https://chatgpt.com/backend-api/v1";
const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const DEFAULT_CONTEXT_WINDOW = 200_000;
const OPENROUTER_FALLBACK_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

type ModelRegistryLike = {
  find: (provider: string, modelId: string) => unknown;
};

type DynamicModelContext = {
  provider: string;
  modelId: string;
  modelRegistry: ModelRegistryLike;
  agentRuntimeId?: string;
  authProfileMode?: "api_key" | "aws-sdk" | "oauth" | "token";
  providerConfig?: {
    api?: string | null;
    auth?: ModelProviderAuthMode;
    baseUrl?: string;
  };
};

type ResolvedModelLike = Record<string, unknown>;
type NormalizedTransportLike = {
  api?: string | null;
  baseUrl?: string;
};

type ProviderRuntimeTestMockOptions = {
  handledDynamicProviders?: readonly string[];
};

function findTemplate(
  ctx: { modelRegistry: ModelRegistryLike },
  provider: string,
  templateIds: readonly string[],
) {
  // Forward-compat fallbacks clone the nearest known catalog row from the
  // registry before patching the requested id/provider.
  for (const templateId of templateIds) {
    const template = ctx.modelRegistry.find(provider, templateId) as ResolvedModelLike | null;
    if (template) {
      return template;
    }
  }
  return undefined;
}

function cloneTemplate(
  template: ResolvedModelLike | undefined,
  modelId: string,
  patch: ResolvedModelLike,
  fallback: ResolvedModelLike,
) {
  return {
    ...(template ?? fallback),
    id: modelId,
    name: modelId,
    ...patch,
  } as ResolvedModelLike;
}

function modelDefaults(
  provider: string,
  api: string,
  baseUrl?: string,
  overrides: ResolvedModelLike = {},
): ResolvedModelLike {
  return {
    provider,
    api,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    reasoning: true,
    input: ["text", "image"],
    cost: OPENROUTER_FALLBACK_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_CONTEXT_WINDOW,
    ...overrides,
  };
}

function openAIPrice(input: number, output: number, cacheRead = 0) {
  return { input, output, cacheRead, cacheWrite: 0 };
}

function isOpenAIChatGptModelTemplate(model: ResolvedModelLike | null | undefined): boolean {
  return (
    model?.api === "openai-chatgpt-responses" ||
    isNativeOpenAICodexBaseUrl(typeof model?.baseUrl === "string" ? model.baseUrl : undefined)
  );
}

function isNativeOpenAICodexBaseUrl(baseUrl?: string): boolean {
  return baseUrl === OPENAI_CODEX_BASE_URL || baseUrl === OPENAI_CODEX_LEGACY_BASE_URL;
}

function normalizeDynamicModel(params: { provider: string; model: ResolvedModelLike }) {
  // This mock mirrors provider-owned normalization contracts that model tests
  // need without loading real plugin runtimes.
  if (params.provider !== "openai") {
    return undefined;
  }
  const baseUrl = typeof params.model.baseUrl === "string" ? params.model.baseUrl : undefined;
  const useCodexTransport =
    (params.model.api === "openai-chatgpt-responses" &&
      (!baseUrl || baseUrl === OPENAI_BASE_URL || isNativeOpenAICodexBaseUrl(baseUrl))) ||
    isNativeOpenAICodexBaseUrl(baseUrl);
  const nextApi = useCodexTransport ? "openai-chatgpt-responses" : params.model.api;
  const nextBaseUrl =
    nextApi === "openai-chatgpt-responses" && useCodexTransport ? OPENAI_CODEX_BASE_URL : baseUrl;
  if (nextApi !== params.model.api || nextBaseUrl !== baseUrl) {
    return { ...params.model, api: nextApi, baseUrl: nextBaseUrl };
  }
  return undefined;
}

function normalizeTransport(params: {
  provider: string;
  context: { api?: string | null; baseUrl?: string };
}): NormalizedTransportLike | undefined {
  // Transport normalization proves provider hooks can upgrade legacy endpoints
  // and API names before resolved models are returned to callers.
  const {
    provider,
    context: { api, baseUrl },
  } = params;
  const isNativeOpenAiTransport =
    api === "openai-completions" &&
    (baseUrl === OPENAI_BASE_URL || (provider === "openai" && !baseUrl));
  const isNativeOpenAICodexTransport =
    provider === "openai" &&
    ((api === "openai-chatgpt-responses" &&
      (!baseUrl || baseUrl === OPENAI_BASE_URL || isNativeOpenAICodexBaseUrl(baseUrl))) ||
      isNativeOpenAICodexBaseUrl(baseUrl));
  if (isNativeOpenAiTransport) {
    return {
      api: "openai-responses",
      baseUrl,
    };
  }
  if (isNativeOpenAICodexTransport) {
    return {
      api: "openai-chatgpt-responses",
      baseUrl: OPENAI_CODEX_BASE_URL,
    };
  }
  return undefined;
}

function buildDynamicModel(params: DynamicModelContext) {
  const modelId = params.modelId.trim();
  const lower = lowercasePreservingWhitespace(modelId);
  switch (params.provider) {
    case "openai": {
      const isLegacyGpt54Alias = lower === "gpt-5.4-codex";
      const isSparkModel = lower === "gpt-5.3-codex-spark";
      const exactModel = params.modelRegistry.find("openai", modelId) as ResolvedModelLike | null;
      const explicitResponsesAuth =
        params.authProfileMode === "api_key" ||
        params.authProfileMode === "aws-sdk" ||
        params.providerConfig?.auth === "api-key" ||
        params.providerConfig?.auth === "aws-sdk";
      const explicitCodexAuth =
        params.authProfileMode === "oauth" ||
        params.authProfileMode === "token" ||
        params.providerConfig?.auth === "oauth" ||
        params.providerConfig?.auth === "token";
      const providerConfigSelectsChatGpt =
        !explicitResponsesAuth &&
        (explicitCodexAuth ||
          params.providerConfig?.api === "openai-chatgpt-responses" ||
          isNativeOpenAICodexBaseUrl(params.providerConfig?.baseUrl) ||
          params.agentRuntimeId === "codex");
      if (
        lower === "gpt-5.5" &&
        (providerConfigSelectsChatGpt || isOpenAIChatGptModelTemplate(exactModel))
      ) {
        const model = exactModel;
        if (model) {
          const modelContextTokens = model.contextTokens;
          const modelContextWindow = model.contextWindow;
          const contextTokens =
            typeof modelContextTokens === "number"
              ? modelContextTokens
              : Math.min(
                  272_000,
                  typeof modelContextWindow === "number" ? modelContextWindow : 272_000,
                );
          return { ...model, contextWindow: 400_000, contextTokens };
        }
        return cloneTemplate(
          undefined,
          modelId,
          modelDefaults("openai", "openai-chatgpt-responses", OPENAI_CODEX_BASE_URL, {
            contextWindow: 400_000,
            contextTokens: 272_000,
            maxTokens: 128_000,
          }),
          {},
        );
      }
      const codexTemplate =
        lower === "gpt-5.5-pro"
          ? findTemplate(params, "openai", ["gpt-5.4", "gpt-5.4-pro", "gpt-5.3-codex"])
          : lower === "gpt-5.4" ||
              isLegacyGpt54Alias ||
              lower === "gpt-5.4-pro" ||
              lower === "gpt-5.4-mini"
            ? findTemplate(params, "openai", ["gpt-5.4", "gpt-5.3-codex", "gpt-5.2-codex"])
            : lower === "gpt-5.3-codex-spark"
              ? findTemplate(params, "openai", ["gpt-5.4", "gpt-5.3-codex", "gpt-5.2-codex"])
              : findTemplate(params, "openai", ["gpt-5.4"]);
      const templateSelectsChatGpt = !isSparkModel && isOpenAIChatGptModelTemplate(codexTemplate);
      if (
        isLegacyGpt54Alias ||
        (lower.includes("-codex") && !isSparkModel) ||
        providerConfigSelectsChatGpt ||
        templateSelectsChatGpt
      ) {
        const templateBaseUrl =
          typeof codexTemplate?.baseUrl === "string" ? codexTemplate.baseUrl : undefined;
        const chatGptBaseUrl = isNativeOpenAICodexBaseUrl(templateBaseUrl)
          ? OPENAI_CODEX_BASE_URL
          : (templateBaseUrl ?? OPENAI_CODEX_BASE_URL);
        const fallback = modelDefaults("openai", "openai-chatgpt-responses", chatGptBaseUrl);
        const chatGptPatch = {
          provider: "openai",
          api: "openai-chatgpt-responses",
          baseUrl: chatGptBaseUrl,
          contextTokens: 272_000,
          maxTokens: 128_000,
        };
        const patches: Record<string, ResolvedModelLike> = {
          "gpt-5.5-pro": { ...chatGptPatch, cost: openAIPrice(30, 180), contextWindow: 1_000_000 },
          "gpt-5.4": {
            ...chatGptPatch,
            cost: openAIPrice(2.5, 15, 0.25),
            contextWindow: 1_050_000,
          },
          "gpt-5.4-pro": { ...chatGptPatch, cost: openAIPrice(30, 180), contextWindow: 1_050_000 },
          "gpt-5.4-mini": {
            ...chatGptPatch,
            cost: openAIPrice(0.75, 4.5, 0.075),
            contextWindow: 400_000,
          },
          "gpt-5.3-codex-spark": {
            provider: "openai",
            api: "openai-chatgpt-responses",
            baseUrl: chatGptBaseUrl,
            reasoning: true,
            input: ["text"],
            cost: OPENROUTER_FALLBACK_COST,
            contextWindow: 128_000,
            maxTokens: 128_000,
          },
        };
        const key = isLegacyGpt54Alias ? "gpt-5.4" : lower;
        const patch = Object.hasOwn(patches, key) ? patches[key] : undefined;
        if (patch) {
          return cloneTemplate(
            codexTemplate,
            isLegacyGpt54Alias ? "gpt-5.4" : lower === "gpt-5.4" ? "gpt-5.4" : modelId,
            patch,
            fallback,
          );
        }
        return undefined;
      }
      const templateIds =
        lower === "gpt-5.5"
          ? ["gpt-5.5", "gpt-5.4", "gpt-5.4-pro"]
          : lower === "gpt-5.4"
            ? ["gpt-5.4"]
            : lower === "gpt-5.4-pro"
              ? ["gpt-5.4-pro", "gpt-5.4"]
              : lower === "gpt-5.4-mini"
                ? ["gpt-5.4-mini"]
                : lower === "gpt-5.4-nano"
                  ? ["gpt-5.4-nano", "gpt-5.4-mini"]
                  : undefined;
      if (!templateIds) {
        return undefined;
      }
      const template = findTemplate(params, "openai", templateIds);
      const preserveTemplateTransport =
        template?.api === "openai-completions" &&
        typeof template.baseUrl === "string" &&
        template.baseUrl !== OPENAI_BASE_URL;
      const patch = modelDefaults("openai", "openai-responses", OPENAI_BASE_URL, {
        maxTokens: 128_000,
        ...(lower === "gpt-5.5"
          ? {
              cost: openAIPrice(5, 30, 0.5),
              contextWindow: 1_000_000,
              contextTokens: 272_000,
              mediaInput: {
                image: { maxSidePx: 6000, preferredSidePx: 2048, tokenMode: "detail" },
              },
            }
          : lower === "gpt-5.4"
            ? { cost: openAIPrice(2.5, 15, 0.25), contextWindow: 1_050_000 }
            : lower === "gpt-5.4-pro"
              ? { cost: openAIPrice(30, 180), contextWindow: 1_050_000 }
              : lower === "gpt-5.4-mini"
                ? { cost: openAIPrice(0.75, 4.5, 0.075), contextWindow: 400_000 }
                : { cost: openAIPrice(0.2, 1.25, 0.02), contextWindow: 400_000 }),
      });
      return cloneTemplate(
        template,
        modelId,
        {
          ...patch,
          ...(preserveTemplateTransport ? { api: template.api, baseUrl: template.baseUrl } : {}),
        },
        modelDefaults("openai", "openai-responses", OPENAI_BASE_URL, {
          contextWindow: patch.contextWindow,
          maxTokens: patch.maxTokens,
        }),
      );
    }
    case "anthropic":
    case "claude-cli": {
      if (lower !== "claude-opus-4-6" && lower !== "claude-sonnet-4-6") {
        return undefined;
      }
      const template = findTemplate(
        params,
        "anthropic",
        lower === "claude-opus-4-6" ? ["claude-opus-4-6"] : ["claude-sonnet-4-6"],
      );
      return cloneTemplate(
        template,
        modelId,
        {
          provider: params.provider,
          api: "anthropic-messages",
          baseUrl: ANTHROPIC_BASE_URL,
          reasoning: true,
        },
        modelDefaults(params.provider, "anthropic-messages", ANTHROPIC_BASE_URL),
      );
    }
    default:
      return undefined;
  }
}

export function createProviderRuntimeTestMock(options: ProviderRuntimeTestMockOptions = {}) {
  const handledDynamicProviders = new Set(
    options.handledDynamicProviders ?? [
      "openrouter",
      "github-copilot",
      "openai",
      "xai",
      "anthropic",
      "google-antigravity",
      "zai",
    ],
  );

  return {
    buildProviderUnknownModelHintWithPlugin: (params: { provider: string }) => {
      switch (params.provider) {
        case "ollama":
          return (
            "Ollama requires authentication to be registered as a provider. " +
            'Set OLLAMA_API_KEY="ollama-local" (any value works) or run "openclaw configure". ' +
            "See: https://docs.openclaw.ai/providers/ollama"
          );
        default:
          return undefined;
      }
    },
    runProviderDynamicModel: (params: {
      provider: string;
      context: Omit<DynamicModelContext, "provider">;
    }) =>
      handledDynamicProviders.has(params.provider)
        ? buildDynamicModel({ ...params.context, provider: params.provider })
        : undefined,
    shouldPreferProviderRuntimeResolvedModel: (params: {
      provider: string;
      context: { modelId: string };
    }) =>
      params.provider === "openai" &&
      ["gpt-5.5", "gpt-5.5-pro", "gpt-5.4", "gpt-5.4-pro", "gpt-5.3-codex-spark"].includes(
        params.context.modelId.trim().toLowerCase(),
      ),
    prepareProviderDynamicModel: async (_params: {
      provider: string;
      context: { modelId: string };
    }) => undefined,
    normalizeProviderResolvedModelWithPlugin: (params: {
      provider: string;
      context: { model: unknown };
    }) =>
      handledDynamicProviders.has(params.provider)
        ? normalizeDynamicModel({
            provider: params.provider,
            model: params.context.model as ResolvedModelLike,
          })
        : undefined,
    applyProviderResolvedTransportWithPlugin: (params: {
      provider: string;
      config?: unknown;
      workspaceDir?: string;
      env?: NodeJS.ProcessEnv;
      context: { model: unknown };
    }) => {
      const model = params.context.model as ResolvedModelLike;
      const normalized = normalizeTransport({
        provider: params.provider,
        context: {
          api: model.api as string | null | undefined,
          baseUrl: model.baseUrl as string | undefined,
        },
      });
      if (!normalized) {
        return undefined;
      }
      const nextApi = normalized.api ?? model.api;
      const nextBaseUrl = normalized.baseUrl ?? model.baseUrl;
      if (nextApi === model.api && nextBaseUrl === model.baseUrl) {
        return undefined;
      }
      return {
        ...model,
        api: nextApi,
        baseUrl: nextBaseUrl,
      };
    },
    normalizeProviderTransportWithPlugin: (params: {
      provider: string;
      context: { api?: string | null; baseUrl?: string };
    }) => normalizeTransport(params),
  };
}
