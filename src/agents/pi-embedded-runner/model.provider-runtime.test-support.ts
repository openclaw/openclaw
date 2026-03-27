import type { OpenRouterModelCapabilities } from "./openrouter-model-capabilities.js";

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const ZAI_BASE_URL = "https://api.z.ai/api/paas/v4";
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 8192;
const OPENROUTER_FALLBACK_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

type ModelRegistryLike = {
  find: (provider: string, modelId: string) => unknown;
};

type DynamicModelContext = {
  provider: string;
  modelId: string;
  modelRegistry: ModelRegistryLike;
};

type ResolvedModelLike = Record<string, unknown>;

type ProviderRuntimeTestMockOptions = {
  clearHookCache?: () => void;
  getOpenRouterModelCapabilities?: (modelId: string) => OpenRouterModelCapabilities | undefined;
  handledDynamicProviders?: readonly string[];
  loadOpenRouterModelCapabilities?: (modelId: string) => Promise<void>;
};

function findTemplate(
  ctx: { modelRegistry: ModelRegistryLike },
  provider: string,
  templateIds: readonly string[],
) {
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

function normalizeDynamicModel(params: { provider: string; model: ResolvedModelLike }) {
  if (params.provider === "openai") {
    const baseUrl = typeof params.model.baseUrl === "string" ? params.model.baseUrl : undefined;
    if (params.model.api === "openai-completions" && (!baseUrl || baseUrl === OPENAI_BASE_URL)) {
      return { ...params.model, api: "openai-responses" };
    }
  }
  if (params.provider !== "openai-codex") {
    return undefined;
  }
  const baseUrl = typeof params.model.baseUrl === "string" ? params.model.baseUrl : undefined;
  const nextApi =
    params.model.api === "openai-responses" &&
    (!baseUrl || baseUrl === OPENAI_BASE_URL || baseUrl === OPENAI_CODEX_BASE_URL)
      ? "openai-codex-responses"
      : params.model.api;
  const nextBaseUrl =
    nextApi === "openai-codex-responses" && (!baseUrl || baseUrl === OPENAI_BASE_URL)
      ? OPENAI_CODEX_BASE_URL
      : baseUrl;
  if (nextApi !== params.model.api || nextBaseUrl !== baseUrl) {
    return { ...params.model, api: nextApi, baseUrl: nextBaseUrl };
  }
  return undefined;
}

function isGlm5ForwardCompatModelId(modelId: string): boolean {
  const lower = modelId.trim().toLowerCase();
  return lower === "glm-5" || lower.startsWith("glm-5.") || lower.startsWith("glm-5-");
}

function buildDynamicModel(
  params: DynamicModelContext,
  options: Required<
    Pick<
      ProviderRuntimeTestMockOptions,
      "getOpenRouterModelCapabilities" | "loadOpenRouterModelCapabilities"
    >
  >,
) {
  const modelId = params.modelId.trim();
  const lower = modelId.toLowerCase();
  switch (params.provider) {
    case "openrouter": {
      const capabilities = options.getOpenRouterModelCapabilities(modelId);
      return {
        id: modelId,
        name: capabilities?.name ?? modelId,
        api: "openai-completions" as const,
        provider: "openrouter",
        baseUrl: OPENROUTER_BASE_URL,
        reasoning: capabilities?.reasoning ?? false,
        input: capabilities?.input ?? (["text"] as const),
        cost: capabilities?.cost ?? OPENROUTER_FALLBACK_COST,
        contextWindow: capabilities?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
        maxTokens: capabilities?.maxTokens ?? DEFAULT_MAX_TOKENS,
      };
    }
    case "github-copilot": {
      const existing = params.modelRegistry.find("github-copilot", lower);
      if (existing) {
        return undefined;
      }
      const template = findTemplate(params, "github-copilot", ["gpt-5.2-codex"]);
      if (lower === "gpt-5.4" && template) {
        return cloneTemplate(
          template,
          modelId,
          {},
          {
            provider: "github-copilot",
            api: "openai-responses",
            reasoning: false,
            input: ["text", "image"],
            cost: OPENROUTER_FALLBACK_COST,
            contextWindow: 128_000,
            maxTokens: DEFAULT_MAX_TOKENS,
          },
        );
      }
      return {
        id: modelId,
        name: modelId,
        provider: "github-copilot",
        api: "openai-responses",
        reasoning: /^o[13](\b|$)/.test(lower),
        input: ["text", "image"],
        cost: OPENROUTER_FALLBACK_COST,
        contextWindow: 128_000,
        maxTokens: DEFAULT_MAX_TOKENS,
      };
    }
    case "openai-codex": {
      const template =
        lower === "gpt-5.4"
          ? findTemplate(params, "openai-codex", ["gpt-5.4", "gpt-5.2-codex"])
          : lower === "gpt-5.3-codex-spark"
            ? findTemplate(params, "openai-codex", ["gpt-5.4", "gpt-5.2-codex"])
            : findTemplate(params, "openai-codex", ["gpt-5.2-codex"]);
      const fallback = {
        provider: "openai-codex",
        api: "openai-codex-responses",
        baseUrl: OPENAI_CODEX_BASE_URL,
        reasoning: true,
        input: ["text", "image"],
        cost: OPENROUTER_FALLBACK_COST,
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        maxTokens: DEFAULT_CONTEXT_WINDOW,
      };
      if (lower === "gpt-5.4") {
        return cloneTemplate(
          template,
          modelId,
          {
            provider: "openai-codex",
            api: "openai-codex-responses",
            baseUrl: OPENAI_CODEX_BASE_URL,
            contextWindow: 1_050_000,
            maxTokens: 128_000,
          },
          fallback,
        );
      }
      if (lower === "gpt-5.3-codex-spark") {
        return cloneTemplate(
          template,
          modelId,
          {
            provider: "openai-codex",
            api: "openai-codex-responses",
            baseUrl: OPENAI_CODEX_BASE_URL,
            reasoning: true,
            input: ["text"],
            cost: OPENROUTER_FALLBACK_COST,
            contextWindow: 128_000,
            maxTokens: 128_000,
          },
          fallback,
        );
      }
      return undefined;
    }
    case "openai": {
      const templateIds =
        lower === "gpt-5.4"
          ? ["gpt-5.2"]
          : lower === "gpt-5.4-pro"
            ? ["gpt-5.2-pro", "gpt-5.2"]
            : lower === "gpt-5.4-mini"
              ? ["gpt-5-mini"]
              : lower === "gpt-5.4-nano"
                ? ["gpt-5-nano", "gpt-5-mini"]
                : undefined;
      if (!templateIds) {
        return undefined;
      }
      const template = findTemplate(params, "openai", templateIds);
      const patch =
        lower === "gpt-5.4" || lower === "gpt-5.4-pro"
          ? {
              provider: "openai",
              api: "openai-responses",
              baseUrl: OPENAI_BASE_URL,
              reasoning: true,
              input: ["text", "image"],
              contextWindow: 1_050_000,
              maxTokens: 128_000,
            }
          : {
              provider: "openai",
              api: "openai-responses",
              baseUrl: OPENAI_BASE_URL,
              reasoning: true,
              input: ["text", "image"],
            };
      return cloneTemplate(template, modelId, patch, {
        provider: "openai",
        api: "openai-responses",
        baseUrl: OPENAI_BASE_URL,
        reasoning: true,
        input: ["text", "image"],
        cost: OPENROUTER_FALLBACK_COST,
        contextWindow: patch.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
        maxTokens: patch.maxTokens ?? DEFAULT_CONTEXT_WINDOW,
      });
    }
    case "anthropic": {
      if (lower !== "claude-opus-4-6" && lower !== "claude-sonnet-4-6") {
        return undefined;
      }
      const template = findTemplate(
        params,
        "anthropic",
        lower === "claude-opus-4-6" ? ["claude-opus-4-5"] : ["claude-sonnet-4-5"],
      );
      return cloneTemplate(
        template,
        modelId,
        {
          provider: "anthropic",
          api: "anthropic-messages",
          baseUrl: ANTHROPIC_BASE_URL,
          reasoning: true,
        },
        {
          provider: "anthropic",
          api: "anthropic-messages",
          baseUrl: ANTHROPIC_BASE_URL,
          reasoning: true,
          input: ["text", "image"],
          cost: OPENROUTER_FALLBACK_COST,
          contextWindow: DEFAULT_CONTEXT_WINDOW,
          maxTokens: DEFAULT_CONTEXT_WINDOW,
        },
      );
    }
    case "zai": {
      if (!isGlm5ForwardCompatModelId(modelId)) {
        return undefined;
      }
      const template = findTemplate(params, "zai", ["glm-4.7"]);
      return cloneTemplate(
        template,
        modelId,
        {
          provider: "zai",
          api: "openai-completions",
          baseUrl: ZAI_BASE_URL,
          reasoning: true,
        },
        {
          provider: "zai",
          api: "openai-completions",
          baseUrl: ZAI_BASE_URL,
          reasoning: true,
          input: ["text"],
          cost: OPENROUTER_FALLBACK_COST,
          contextWindow: DEFAULT_CONTEXT_WINDOW,
          maxTokens: DEFAULT_CONTEXT_WINDOW,
        },
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
      "openai-codex",
      "openai",
      "anthropic",
      "zai",
    ],
  );
  const getOpenRouterModelCapabilities =
    options.getOpenRouterModelCapabilities ?? (() => undefined);
  const loadOpenRouterModelCapabilities =
    options.loadOpenRouterModelCapabilities ?? (async () => {});

  return {
    clearProviderRuntimeHookCache: options.clearHookCache ?? (() => {}),
    buildProviderUnknownModelHintWithPlugin: (params: { provider: string }) => {
      switch (params.provider) {
        case "ollama":
          return (
            "Ollama requires authentication to be registered as a provider. " +
            'Set OLLAMA_API_KEY="ollama-local" (any value works) or run "openclaw configure". ' +
            "See: https://docs.openclaw.ai/providers/ollama"
          );
        case "vllm":
          return (
            "vLLM requires authentication to be registered as a provider. " +
            'Set VLLM_API_KEY (any value works) or run "openclaw configure". ' +
            "See: https://docs.openclaw.ai/providers/vllm"
          );
        default:
          return undefined;
      }
    },
    resolveProviderRuntimePlugin: ({ provider }: { provider: string }) =>
      handledDynamicProviders.has(provider)
        ? {
            id: provider,
            prepareDynamicModel:
              provider === "openrouter"
                ? async ({ modelId }: { modelId: string }) => {
                    await loadOpenRouterModelCapabilities(modelId);
                  }
                : undefined,
            resolveDynamicModel: (ctx: DynamicModelContext) =>
              buildDynamicModel(ctx, {
                getOpenRouterModelCapabilities,
                loadOpenRouterModelCapabilities,
              }),
            normalizeResolvedModel: (ctx: { provider: string; model: ResolvedModelLike }) =>
              normalizeDynamicModel(ctx),
          }
        : undefined,
    runProviderDynamicModel: (params: {
      provider: string;
      context: { modelId: string; modelRegistry: ModelRegistryLike };
    }) =>
      handledDynamicProviders.has(params.provider)
        ? buildDynamicModel(
            {
              provider: params.provider,
              modelId: params.context.modelId,
              modelRegistry: params.context.modelRegistry,
            },
            {
              getOpenRouterModelCapabilities,
              loadOpenRouterModelCapabilities,
            },
          )
        : undefined,
    prepareProviderDynamicModel: async (params: {
      provider: string;
      context: { modelId: string };
    }) =>
      params.provider === "openrouter"
        ? await loadOpenRouterModelCapabilities(params.context.modelId)
        : undefined,
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
  };
}
