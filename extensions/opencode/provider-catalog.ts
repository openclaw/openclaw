import type { ModelCatalogEntry } from "openclaw/plugin-sdk/agent-runtime";
import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeModelCompat } from "openclaw/plugin-sdk/provider-model-shared";

const PROVIDER_ID = "opencode";

const OPENCODE_ZEN_OPENAI_BASE_URL = "https://opencode.ai/zen/v1";

const OPENCODE_ZEN_MODELS = (
  [
    {
      id: "deepseek-v4-flash-free",
      name: "DeepSeek V4 Flash (Free)",
      api: "openai-completions",
      provider: PROVIDER_ID,
      baseUrl: OPENCODE_ZEN_OPENAI_BASE_URL,
      reasoning: true,
      input: ["text"],
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextWindow: 65_536,
      maxTokens: 8_192,
    },
    {
      id: "claude-opus-4-6",
      name: "Claude Opus 4.6 (via Zen)",
      api: "openai-responses",
      provider: PROVIDER_ID,
      baseUrl: OPENCODE_ZEN_OPENAI_BASE_URL,
      reasoning: true,
      input: ["text", "image"],
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextWindow: 200_000,
      maxTokens: 8_192,
    },
    {
      id: "claude-opus-4-7",
      name: "Claude Opus 4.7 (via Zen)",
      api: "openai-responses",
      provider: PROVIDER_ID,
      baseUrl: OPENCODE_ZEN_OPENAI_BASE_URL,
      reasoning: true,
      input: ["text", "image"],
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextWindow: 200_000,
      maxTokens: 8_192,
    },
    {
      id: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6 (via Zen)",
      api: "openai-responses",
      provider: PROVIDER_ID,
      baseUrl: OPENCODE_ZEN_OPENAI_BASE_URL,
      reasoning: true,
      input: ["text", "image"],
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextWindow: 200_000,
      maxTokens: 8_192,
    },
    {
      id: "gemini-2.5-pro",
      name: "Gemini 2.5 Pro (via Zen)",
      api: "openai-responses",
      provider: PROVIDER_ID,
      baseUrl: OPENCODE_ZEN_OPENAI_BASE_URL,
      reasoning: true,
      input: ["text", "image"],
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextWindow: 1_000_000,
      maxTokens: 64_000,
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

export function normalizeOpencodeZenBaseUrl(params: {
  api?: string | null;
  baseUrl?: string;
}): string | undefined {
  const normalized = normalizeBaseUrl(params.baseUrl);
  if (!normalized) {
    return undefined;
  }
  if (normalized === OPENCODE_ZEN_OPENAI_BASE_URL) {
    return OPENCODE_ZEN_OPENAI_BASE_URL;
  }
  if (normalized === "https://opencode.ai/zen") {
    return OPENCODE_ZEN_OPENAI_BASE_URL;
  }
  if (normalized === "https://opencode.ai") {
    return OPENCODE_ZEN_OPENAI_BASE_URL;
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
