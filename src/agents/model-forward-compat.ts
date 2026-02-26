import type { Api, Model } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { DEFAULT_CONTEXT_TOKENS } from "./defaults.js";
import { normalizeModelCompat } from "./model-compat.js";
import { normalizeProviderId } from "./model-selection.js";

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
  if (trimmedModelId.toLowerCase() !== OPENAI_CODEX_GPT_53_MODEL_ID) {
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
    resolveOpenAICodexGpt53FallbackModel(provider, modelId, modelRegistry) ??
    resolveAnthropicOpus46ForwardCompatModel(provider, modelId, modelRegistry) ??
    resolveAnthropicSonnet46ForwardCompatModel(provider, modelId, modelRegistry) ??
    resolveZaiGlm5ForwardCompatModel(provider, modelId, modelRegistry)
  );
}
