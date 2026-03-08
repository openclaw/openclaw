import type { Api, Model } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { DEFAULT_CONTEXT_TOKENS } from "./defaults.js";
import { normalizeModelCompat } from "./model-compat.js";
import { normalizeProviderId } from "./model-selection.js";

const OPENAI_GPT_54_MODEL_ID = "gpt-5.4";
const OPENAI_GPT_54_PRO_MODEL_ID = "gpt-5.4-pro";
const OPENAI_GPT_54_CONTEXT_TOKENS = 1_050_000;
const OPENAI_GPT_54_MAX_TOKENS = 128_000;
const OPENAI_GPT_54_TEMPLATE_MODEL_IDS = ["gpt-5.2"] as const;
const OPENAI_GPT_54_PRO_TEMPLATE_MODEL_IDS = ["gpt-5.2-pro", "gpt-5.2"] as const;

const OPENAI_CODEX_GPT_54_MODEL_ID = "gpt-5.4";
const OPENAI_CODEX_GPT_54_TEMPLATE_MODEL_IDS = ["gpt-5.3-codex", "gpt-5.2-codex"] as const;
const OPENAI_CODEX_GPT_53_MODEL_ID = "gpt-5.3-codex";
const OPENAI_CODEX_TEMPLATE_MODEL_IDS = ["gpt-5.2-codex"] as const;

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

function resolveOpenAIGpt54ForwardCompatModel(
  provider: string,
  modelId: string,
  modelRegistry: ModelRegistry,
): Model<Api> | undefined {
  const normalizedProvider = normalizeProviderId(provider);
  if (normalizedProvider !== "openai") {
    return undefined;
  }

  const trimmedModelId = modelId.trim();
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
      normalizedProvider,
      trimmedModelId,
      templateIds: [...templateIds],
      modelRegistry,
      patch: {
        api: "openai-responses",
        provider: normalizedProvider,
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
      provider: normalizedProvider,
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: OPENAI_GPT_54_CONTEXT_TOKENS,
      maxTokens: OPENAI_GPT_54_MAX_TOKENS,
    } as Model<Api>)
  );
}

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

const CODEX_GPT54_ELIGIBLE_PROVIDERS = new Set(["openai-codex"]);
const CODEX_GPT53_ELIGIBLE_PROVIDERS = new Set(["openai-codex", "github-copilot"]);

function resolveOpenAICodexForwardCompatModel(
  provider: string,
  modelId: string,
  modelRegistry: ModelRegistry,
): Model<Api> | undefined {
  const normalizedProvider = normalizeProviderId(provider);
  const trimmedModelId = modelId.trim();
  const lower = trimmedModelId.toLowerCase();

  let templateIds: readonly string[];
  let eligibleProviders: Set<string>;
  // GPT-5.4 on the Codex path supports the same native 1.05M context window as the
  // direct OpenAI provider. Apply the correct capability patch so users see the full
  // context window instead of inheriting the smaller template value.
  let patch: Partial<Model<Api>> | undefined;
  if (lower === OPENAI_CODEX_GPT_54_MODEL_ID) {
    templateIds = OPENAI_CODEX_GPT_54_TEMPLATE_MODEL_IDS;
    eligibleProviders = CODEX_GPT54_ELIGIBLE_PROVIDERS;
    patch = {
      contextWindow: OPENAI_GPT_54_CONTEXT_TOKENS,
      maxTokens: OPENAI_GPT_54_MAX_TOKENS,
    };
  } else if (lower === OPENAI_CODEX_GPT_53_MODEL_ID) {
    templateIds = OPENAI_CODEX_TEMPLATE_MODEL_IDS;
    eligibleProviders = CODEX_GPT53_ELIGIBLE_PROVIDERS;
  } else {
    return undefined;
  }

  if (!eligibleProviders.has(normalizedProvider)) {
    return undefined;
  }

  for (const templateId of templateIds) {
    const template = modelRegistry.find(normalizedProvider, templateId) as Model<Api> | null;
    if (!template) {
      continue;
    }
    return normalizeModelCompat({
      ...template,
      id: trimmedModelId,
      name: trimmedModelId,
      ...patch,
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
    contextWindow: patch?.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
    maxTokens: patch?.maxTokens ?? DEFAULT_CONTEXT_TOKENS,
  } as Model<Api>);
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

// gemini-3.1-pro-preview / gemini-3.1-flash-preview are not present in some pi-ai
// Google catalogs yet. Clone the nearest gemini-3 template so users don't get
// "Unknown model" errors when Google ships new minor-version models before pi-ai
// updates its built-in registry.
function resolveGoogle31ForwardCompatModel(
  provider: string,
  modelId: string,
  modelRegistry: ModelRegistry,
): Model<Api> | undefined {
  const normalizedProvider = normalizeProviderId(provider);
  if (normalizedProvider !== "google" && normalizedProvider !== "google-gemini-cli") {
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
    normalizedProvider,
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
    resolveOpenAICodexForwardCompatModel(provider, modelId, modelRegistry) ??
    resolveAnthropicOpus46ForwardCompatModel(provider, modelId, modelRegistry) ??
    resolveAnthropicSonnet46ForwardCompatModel(provider, modelId, modelRegistry) ??
    resolveZaiGlm5ForwardCompatModel(provider, modelId, modelRegistry) ??
    resolveGoogle31ForwardCompatModel(provider, modelId, modelRegistry)
  );
}
