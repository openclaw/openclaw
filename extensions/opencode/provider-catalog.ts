import type { ModelCatalogEntry } from "openclaw/plugin-sdk/agent-runtime";
import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeModelCompat } from "openclaw/plugin-sdk/provider-model-shared";

const PROVIDER_ID = "opencode";

const OPENCODE_ZEN_ANTHROPIC_BASE_URL = "https://opencode.ai/zen";
const OPENCODE_ZEN_OPENAI_BASE_URL = "https://opencode.ai/zen/v1";

const FREE_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const OPENCODE_ZEN_MODELS = (
  [
    // DeepSeek — uses OpenAI Chat Completions format via the Zen proxy
    {
      id: "deepseek-v4-flash-free",
      name: "DeepSeek V4 Flash (Free)",
      api: "openai-completions",
      provider: PROVIDER_ID,
      baseUrl: OPENCODE_ZEN_OPENAI_BASE_URL,
      reasoning: true,
      input: ["text"],
      cost: FREE_COST,
      contextWindow: 65_536,
      maxTokens: 8_192,
    },
    // Claude models — use native Anthropic Messages format via the Zen proxy
    {
      id: "claude-opus-4-6",
      name: "Claude Opus 4.6 (via Zen)",
      api: "anthropic-messages",
      provider: PROVIDER_ID,
      baseUrl: OPENCODE_ZEN_ANTHROPIC_BASE_URL,
      reasoning: true,
      input: ["text", "image"],
      cost: FREE_COST,
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    },
    {
      id: "claude-opus-4-7",
      name: "Claude Opus 4.7 (via Zen)",
      api: "anthropic-messages",
      provider: PROVIDER_ID,
      baseUrl: OPENCODE_ZEN_ANTHROPIC_BASE_URL,
      reasoning: true,
      input: ["text", "image"],
      cost: FREE_COST,
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    },
    {
      id: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6 (via Zen)",
      api: "anthropic-messages",
      provider: PROVIDER_ID,
      baseUrl: OPENCODE_ZEN_ANTHROPIC_BASE_URL,
      reasoning: true,
      input: ["text", "image"],
      cost: FREE_COST,
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    },
    {
      id: "claude-haiku-4-5",
      name: "Claude Haiku 4.5 (via Zen)",
      api: "anthropic-messages",
      provider: PROVIDER_ID,
      baseUrl: OPENCODE_ZEN_ANTHROPIC_BASE_URL,
      reasoning: true,
      input: ["text", "image"],
      cost: FREE_COST,
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    },
  ] satisfies ProviderRuntimeModel[]
).map((model) => normalizeModelCompat(model));

export function listOpencodeZenModelCatalogEntries(): ModelCatalogEntry[] {
  return OPENCODE_ZEN_MODELS.map((model) => ({
    provider: model.provider,
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    input: model.input,
    contextWindow: model.contextWindow,
  }));
}

export function resolveOpencodeZenModel(modelId: string): ProviderRuntimeModel | undefined {
  const normalizedModelId = modelId.trim().toLowerCase();
  return OPENCODE_ZEN_MODELS.find((model) => model.id === normalizedModelId);
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl ?? "").trim().replace(/\/+$/, "");
}

function isAnthropicApi(api: string | null | undefined): boolean {
  return api?.toLowerCase() === "anthropic-messages";
}

function zenBaseUrlForApi(api: string | null | undefined): string | undefined {
  return isAnthropicApi(api) ? OPENCODE_ZEN_ANTHROPIC_BASE_URL : OPENCODE_ZEN_OPENAI_BASE_URL;
}

export function normalizeOpencodeZenBaseUrl(params: {
  api?: string | null;
  baseUrl?: string;
}): string | undefined {
  const normalized = normalizeBaseUrl(params.baseUrl);
  if (!normalized) {
    return undefined;
  }
  const target = zenBaseUrlForApi(params.api);
  if (!target) {
    return undefined;
  }
  if (normalized === target) {
    return target;
  }
  // Accept bare domain or alias
  if (normalized === "https://opencode.ai" || normalized === "https://opencode.ai/zen") {
    return zenBaseUrlForApi(params.api);
  }
  return undefined;
}

export function normalizeOpencodeZenResolvedModel(
  model: ProviderRuntimeModel,
): ProviderRuntimeModel | undefined {
  const normalizedBaseUrl = normalizeOpencodeZenBaseUrl({
    api: model.api,
    baseUrl: model.baseUrl,
  });
  if (normalizedBaseUrl && normalizedBaseUrl !== model.baseUrl) {
    return {
      ...model,
      baseUrl: normalizedBaseUrl,
    };
  }
  return undefined;
}
