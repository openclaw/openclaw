import type { Api, Model } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { DEFAULT_CONTEXT_TOKENS } from "./defaults.js";
import { normalizeModelCompat } from "./model-compat.js";
import { normalizeProviderId } from "./model-selection.js";

const OPENAI_CODEX_GPT_54_MODEL_ID = "gpt-5.4";
const OPENAI_CODEX_GPT_53_MODEL_ID = "gpt-5.3-codex";
const OPENAI_CODEX_GPT_53_SPARK_MODEL_ID = "gpt-5.3-codex-spark";
const OPENAI_CODEX_FORWARD_COMPAT_MODEL_IDS = new Set([
  OPENAI_CODEX_GPT_54_MODEL_ID,
  OPENAI_CODEX_GPT_53_MODEL_ID,
]);
const OPENAI_CODEX_TEMPLATE_MODEL_IDS = ["gpt-5.2-codex"] as const;
const OPENAI_GPT_54_MODEL_ID = "gpt-5.4";
const OPENAI_GPT_54_PRO_MODEL_ID = "gpt-5.4-pro";
const OPENAI_GPT54_MODEL_IDS = new Set([OPENAI_GPT_54_MODEL_ID, OPENAI_GPT_54_PRO_MODEL_ID]);
const OPENAI_GPT54_TEMPLATE_MODEL_IDS = ["gpt-5.2", "gpt-5.1", "gpt-5"] as const;
const OPENAI_GPT54_CONTEXT_WINDOW = 1_050_000;
const OPENAI_GPT54_MAX_TOKENS = 128_000;
const OPENAI_CODEX_SPARK_CONTEXT_WINDOW = 272_000;
const OPENAI_CODEX_SPARK_MAX_TOKENS = 128_000;
const OPENAI_GPT54_COST = { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 } as const;
// OpenAI currently publishes no cached-input price for GPT-5.4 Pro, so keep cacheRead at 0.
const OPENAI_GPT54_PRO_COST = { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 } as const;

const ANTHROPIC_OPUS_46_MODEL_ID = "claude-opus-4-6";
const ANTHROPIC_OPUS_46_DOT_MODEL_ID = "claude-opus-4.6";
const ANTHROPIC_OPUS_TEMPLATE_MODEL_IDS = ["claude-opus-4-5", "claude-opus-4.5"] as const;
const ANTHROPIC_SONNET_46_MODEL_ID = "claude-sonnet-4-6";
const ANTHROPIC_SONNET_46_DOT_MODEL_ID = "claude-sonnet-4.6";
const ANTHROPIC_SONNET_TEMPLATE_MODEL_IDS = ["claude-sonnet-4-5", "claude-sonnet-4.5"] as const;

const ZAI_GLM5_MODEL_ID = "glm-5";
const ZAI_GLM5_TEMPLATE_MODEL_IDS = ["glm-4.7"] as const;

// gemini-3.1-pro-preview / gemini-3.1-flash-preview are not yet in pi-ai's built-in
// google-gemini-cli catalog. Clone the gemini-3-pro/flash-preview template so users
// don't get "Unknown model" errors when Google releases a new minor version.
const GEMINI_3_1_PRO_PREFIX = "gemini-3.1-pro";
const GEMINI_3_1_FLASH_PREFIX = "gemini-3.1-flash";
const GEMINI_3_1_PRO_TEMPLATE_IDS = ["gemini-3-pro-preview"] as const;
const GEMINI_3_1_FLASH_TEMPLATE_IDS = ["gemini-3-flash-preview"] as const;

function cloneFirstTemplateModel(params: {
  normalizedProvider: string;
  trimmedModelId: string;
  templateIds: string[];
  modelRegistry: ModelRegistry;
  patch?: Partial<Model<Api>>;
}): Model<Api> | undefined {
  const { normalizedProvider, trimmedModelId, templateIds, modelRegistry } = params;
  for (const templateId of [...new Set(templateIds)].filter(Boolean)) {
    const template = modelRegistry.find(normalizedProvider, templateId) as Model<Api> | null;
    if (!template) {
      continue;
    }
    return normalizeModelCompat({
      ...template,
      id: trimmedModelId,
      name: trimmedModelId,
      ...params.patch,
    } as Model<Api>);
  }
  return undefined;
}

function buildOpenAIGpt54FallbackModel(modelId: string, template?: Model<Api> | null): Model<Api> {
  return normalizeModelCompat({
    ...template,
    id: modelId,
    name: modelId,
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text", "image"],
    cost:
      modelId.toLowerCase() === OPENAI_GPT_54_PRO_MODEL_ID
        ? OPENAI_GPT54_PRO_COST
        : OPENAI_GPT54_COST,
    contextWindow: OPENAI_GPT54_CONTEXT_WINDOW,
    maxTokens: OPENAI_GPT54_MAX_TOKENS,
  } as Model<Api>);
}

function buildOpenAICodexSparkFallbackModel(template?: Model<Api> | null): Model<Api> {
  return normalizeModelCompat({
    ...template,
    id: OPENAI_CODEX_GPT_53_SPARK_MODEL_ID,
    name: OPENAI_CODEX_GPT_53_SPARK_MODEL_ID,
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api",
    reasoning: true,
    input: ["text", "image"],
    cost: template?.cost ?? { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
    contextWindow: template?.contextWindow ?? OPENAI_CODEX_SPARK_CONTEXT_WINDOW,
    maxTokens: template?.maxTokens ?? OPENAI_CODEX_SPARK_MAX_TOKENS,
  } as Model<Api>);
}

export function augmentKnownForwardCompatModels(models: Model<Api>[]): Model<Api>[] {
  const next = [...models];
  const existing = new Set(
    next.map((model) => `${normalizeProviderId(model.provider)}::${model.id.trim().toLowerCase()}`),
  );
  const getKey = (provider: string, id: string) =>
    `${normalizeProviderId(provider)}::${id.trim().toLowerCase()}`;
  const hasProvider = (provider: string) =>
    next.some((model) => normalizeProviderId(model.provider) === provider);

  if (hasProvider("openai")) {
    const openAiTemplate =
      next.find(
        (model) =>
          normalizeProviderId(model.provider) === "openai" &&
          [...OPENAI_GPT54_TEMPLATE_MODEL_IDS].includes(
            model.id.trim().toLowerCase() as (typeof OPENAI_GPT54_TEMPLATE_MODEL_IDS)[number],
          ),
      ) ?? null;
    for (const modelId of OPENAI_GPT54_MODEL_IDS) {
      const key = getKey("openai", modelId);
      if (existing.has(key)) {
        continue;
      }
      next.push(buildOpenAIGpt54FallbackModel(modelId, openAiTemplate));
      existing.add(key);
    }
  }

  const codexBaseTemplate =
    next.find(
      (model) =>
        normalizeProviderId(model.provider) === "openai-codex" &&
        model.id.trim().toLowerCase() === OPENAI_CODEX_GPT_53_MODEL_ID,
    ) ??
    next.find(
      (model) =>
        normalizeProviderId(model.provider) === "openai-codex" &&
        [...OPENAI_CODEX_TEMPLATE_MODEL_IDS].includes(
          model.id.trim().toLowerCase() as (typeof OPENAI_CODEX_TEMPLATE_MODEL_IDS)[number],
        ),
    ) ??
    null;
  if (codexBaseTemplate) {
    const codex54Key = getKey("openai-codex", OPENAI_CODEX_GPT_54_MODEL_ID);
    if (!existing.has(codex54Key)) {
      next.push(
        normalizeModelCompat({
          ...codexBaseTemplate,
          id: OPENAI_CODEX_GPT_54_MODEL_ID,
          name: OPENAI_CODEX_GPT_54_MODEL_ID,
        } as Model<Api>),
      );
      existing.add(codex54Key);
    }

    const sparkKey = getKey("openai-codex", OPENAI_CODEX_GPT_53_SPARK_MODEL_ID);
    if (!existing.has(sparkKey)) {
      next.push(buildOpenAICodexSparkFallbackModel(codexBaseTemplate));
      existing.add(sparkKey);
    }
  }

  return next;
}

const CODEX_GPT53_ELIGIBLE_PROVIDERS = new Set(["openai-codex", "github-copilot"]);

function resolveOpenAICodexGpt53FallbackModel(
  provider: string,
  modelId: string,
  modelRegistry: ModelRegistry,
): Model<Api> | undefined {
  const normalizedProvider = normalizeProviderId(provider);
  const trimmedModelId = modelId.trim();
  if (!CODEX_GPT53_ELIGIBLE_PROVIDERS.has(normalizedProvider)) {
    return undefined;
  }
  if (!OPENAI_CODEX_FORWARD_COMPAT_MODEL_IDS.has(trimmedModelId.toLowerCase())) {
    return undefined;
  }

  for (const templateId of OPENAI_CODEX_TEMPLATE_MODEL_IDS) {
    const template = modelRegistry.find(normalizedProvider, templateId) as Model<Api> | null;
    if (!template) {
      continue;
    }
    return normalizeModelCompat({
      ...template,
      id: trimmedModelId,
      name: trimmedModelId,
    } as Model<Api>);
  }

  return normalizeModelCompat({
    id: trimmedModelId,
    name: trimmedModelId,
    api: "openai-codex-responses",
    provider: normalizedProvider,
    baseUrl: "https://chatgpt.com/backend-api",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_TOKENS,
    maxTokens: DEFAULT_CONTEXT_TOKENS,
  } as Model<Api>);
}

function resolveOpenAIGpt54ForwardCompatModel(
  provider: string,
  modelId: string,
  modelRegistry: ModelRegistry,
): Model<Api> | undefined {
  if (normalizeProviderId(provider) !== "openai") {
    return undefined;
  }

  const trimmedModelId = modelId.trim();
  const lowerModelId = trimmedModelId.toLowerCase();
  if (!OPENAI_GPT54_MODEL_IDS.has(lowerModelId)) {
    return undefined;
  }

  const template = cloneFirstTemplateModel({
    normalizedProvider: "openai",
    trimmedModelId,
    templateIds: [...OPENAI_GPT54_TEMPLATE_MODEL_IDS],
    modelRegistry,
    patch: {
      api: "openai-responses",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_050_000,
      maxTokens: 128_000,
    },
  });
  if (template) {
    return buildOpenAIGpt54FallbackModel(trimmedModelId, template);
  }

  return buildOpenAIGpt54FallbackModel(trimmedModelId);
}

function resolveAnthropic46ForwardCompatModel(params: {
  provider: string;
  modelId: string;
  modelRegistry: ModelRegistry;
  dashModelId: string;
  dotModelId: string;
  dashTemplateId: string;
  dotTemplateId: string;
  fallbackTemplateIds: readonly string[];
}): Model<Api> | undefined {
  const { provider, modelId, modelRegistry, dashModelId, dotModelId } = params;
  const normalizedProvider = normalizeProviderId(provider);
  if (normalizedProvider !== "anthropic") {
    return undefined;
  }

  const trimmedModelId = modelId.trim();
  const lower = trimmedModelId.toLowerCase();
  const is46Model =
    lower === dashModelId ||
    lower === dotModelId ||
    lower.startsWith(`${dashModelId}-`) ||
    lower.startsWith(`${dotModelId}-`);
  if (!is46Model) {
    return undefined;
  }

  const templateIds: string[] = [];
  if (lower.startsWith(dashModelId)) {
    templateIds.push(lower.replace(dashModelId, params.dashTemplateId));
  }
  if (lower.startsWith(dotModelId)) {
    templateIds.push(lower.replace(dotModelId, params.dotTemplateId));
  }
  templateIds.push(...params.fallbackTemplateIds);

  return cloneFirstTemplateModel({
    normalizedProvider,
    trimmedModelId,
    templateIds,
    modelRegistry,
  });
}

function resolveAnthropicOpus46ForwardCompatModel(
  provider: string,
  modelId: string,
  modelRegistry: ModelRegistry,
): Model<Api> | undefined {
  return resolveAnthropic46ForwardCompatModel({
    provider,
    modelId,
    modelRegistry,
    dashModelId: ANTHROPIC_OPUS_46_MODEL_ID,
    dotModelId: ANTHROPIC_OPUS_46_DOT_MODEL_ID,
    dashTemplateId: "claude-opus-4-5",
    dotTemplateId: "claude-opus-4.5",
    fallbackTemplateIds: ANTHROPIC_OPUS_TEMPLATE_MODEL_IDS,
  });
}

function resolveAnthropicSonnet46ForwardCompatModel(
  provider: string,
  modelId: string,
  modelRegistry: ModelRegistry,
): Model<Api> | undefined {
  return resolveAnthropic46ForwardCompatModel({
    provider,
    modelId,
    modelRegistry,
    dashModelId: ANTHROPIC_SONNET_46_MODEL_ID,
    dotModelId: ANTHROPIC_SONNET_46_DOT_MODEL_ID,
    dashTemplateId: "claude-sonnet-4-5",
    dotTemplateId: "claude-sonnet-4.5",
    fallbackTemplateIds: ANTHROPIC_SONNET_TEMPLATE_MODEL_IDS,
  });
}

// gemini-3.1-pro-preview / gemini-3.1-flash-preview are not present in pi-ai's built-in
// google-gemini-cli catalog yet. Clone the nearest gemini-3 template so users don't get
// "Unknown model" errors when Google Gemini CLI gains new minor-version models.
function resolveGoogleGeminiCli31ForwardCompatModel(
  provider: string,
  modelId: string,
  modelRegistry: ModelRegistry,
): Model<Api> | undefined {
  if (normalizeProviderId(provider) !== "google-gemini-cli") {
    return undefined;
  }
  const trimmed = modelId.trim();
  const lower = trimmed.toLowerCase();

  let templateIds: readonly string[];
  if (lower.startsWith(GEMINI_3_1_PRO_PREFIX)) {
    templateIds = GEMINI_3_1_PRO_TEMPLATE_IDS;
  } else if (lower.startsWith(GEMINI_3_1_FLASH_PREFIX)) {
    templateIds = GEMINI_3_1_FLASH_TEMPLATE_IDS;
  } else {
    return undefined;
  }

  return cloneFirstTemplateModel({
    normalizedProvider: "google-gemini-cli",
    trimmedModelId: trimmed,
    templateIds: [...templateIds],
    modelRegistry,
    patch: { reasoning: true },
  });
}

// Z.ai's GLM-5 may not be present in pi-ai's built-in model catalog yet.
// When a user configures zai/glm-5 without a models.json entry, clone glm-4.7 as a forward-compat fallback.
function resolveZaiGlm5ForwardCompatModel(
  provider: string,
  modelId: string,
  modelRegistry: ModelRegistry,
): Model<Api> | undefined {
  if (normalizeProviderId(provider) !== "zai") {
    return undefined;
  }
  const trimmed = modelId.trim();
  const lower = trimmed.toLowerCase();
  if (lower !== ZAI_GLM5_MODEL_ID && !lower.startsWith(`${ZAI_GLM5_MODEL_ID}-`)) {
    return undefined;
  }

  for (const templateId of ZAI_GLM5_TEMPLATE_MODEL_IDS) {
    const template = modelRegistry.find("zai", templateId) as Model<Api> | null;
    if (!template) {
      continue;
    }
    return normalizeModelCompat({
      ...template,
      id: trimmed,
      name: trimmed,
      reasoning: true,
    } as Model<Api>);
  }

  return normalizeModelCompat({
    id: trimmed,
    name: trimmed,
    api: "openai-completions",
    provider: "zai",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_TOKENS,
    maxTokens: DEFAULT_CONTEXT_TOKENS,
  } as Model<Api>);
}

export function resolveForwardCompatModel(
  provider: string,
  modelId: string,
  modelRegistry: ModelRegistry,
): Model<Api> | undefined {
  return (
    resolveOpenAIGpt54ForwardCompatModel(provider, modelId, modelRegistry) ??
    resolveOpenAICodexGpt53FallbackModel(provider, modelId, modelRegistry) ??
    resolveAnthropicOpus46ForwardCompatModel(provider, modelId, modelRegistry) ??
    resolveAnthropicSonnet46ForwardCompatModel(provider, modelId, modelRegistry) ??
    resolveZaiGlm5ForwardCompatModel(provider, modelId, modelRegistry) ??
    resolveGoogleGeminiCli31ForwardCompatModel(provider, modelId, modelRegistry)
  );
}
