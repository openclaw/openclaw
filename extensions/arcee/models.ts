import type {
  ModelCompatConfig,
  ModelDefinitionConfig,
} from "openclaw/plugin-sdk/provider-model-shared";

export const ARCEE_BASE_URL = "https://api.arcee.ai/api/v1";
export const ARCEE_TRINITY_LARGE_THINKING_COMPAT = {
  supportsReasoningEffort: false,
  supportsTools: false,
} as const satisfies ModelCompatConfig;

const ARCEE_PROVIDER_ID = "arcee";
const ARCEE_TRINITY_LARGE_THINKING_ID = "trinity-large-thinking";
const ARCEE_TRINITY_LARGE_THINKING_REF = `${ARCEE_PROVIDER_ID}/${ARCEE_TRINITY_LARGE_THINKING_ID}`;

function normalizeModelId(modelId: string): string {
  return modelId.trim().toLowerCase();
}

function normalizeBaseUrl(baseUrl: unknown): string {
  return typeof baseUrl === "string" ? baseUrl.trim().replace(/\/+$/, "") : "";
}

export function isArceeTrinityLargeThinkingModelId(modelId: string): boolean {
  const normalized = normalizeModelId(modelId);
  return (
    normalized === ARCEE_TRINITY_LARGE_THINKING_ID ||
    normalized === ARCEE_TRINITY_LARGE_THINKING_REF
  );
}

export function shouldContributeArceeTrinityLargeThinkingCompat(params: {
  provider?: unknown;
  modelId: string;
  model: { id: string; provider?: unknown; baseUrl?: unknown };
}): boolean {
  const modelId = normalizeModelId(params.modelId);
  const resolvedId = normalizeModelId(params.model.id);
  if (
    modelId === ARCEE_TRINITY_LARGE_THINKING_REF ||
    resolvedId === ARCEE_TRINITY_LARGE_THINKING_REF
  ) {
    return true;
  }
  if (
    modelId !== ARCEE_TRINITY_LARGE_THINKING_ID &&
    resolvedId !== ARCEE_TRINITY_LARGE_THINKING_ID
  ) {
    return false;
  }
  if (params.provider === ARCEE_PROVIDER_ID || params.model.provider === ARCEE_PROVIDER_ID) {
    return true;
  }
  return normalizeBaseUrl(params.model.baseUrl) === normalizeBaseUrl(ARCEE_BASE_URL);
}

export const ARCEE_MODEL_CATALOG: ModelDefinitionConfig[] = [
  {
    id: "trinity-mini",
    name: "Trinity Mini 26B",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 80000,
    cost: {
      input: 0.045,
      output: 0.15,
      cacheRead: 0.045,
      cacheWrite: 0.045,
    },
  },
  {
    id: "trinity-large-preview",
    name: "Trinity Large Preview",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 16384,
    cost: {
      input: 0.25,
      output: 1.0,
      cacheRead: 0.25,
      cacheWrite: 0.25,
    },
  },
  {
    id: "trinity-large-thinking",
    name: "Trinity Large Thinking",
    reasoning: true,
    input: ["text"],
    contextWindow: 262144,
    maxTokens: 80000,
    cost: {
      input: 0.25,
      output: 0.9,
      cacheRead: 0.25,
      cacheWrite: 0.25,
    },
    compat: ARCEE_TRINITY_LARGE_THINKING_COMPAT,
  },
];

export function buildArceeModelDefinition(
  model: (typeof ARCEE_MODEL_CATALOG)[number],
): ModelDefinitionConfig {
  return {
    id: model.id,
    name: model.name,
    api: "openai-completions",
    reasoning: model.reasoning,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(model.compat ? { compat: model.compat } : {}),
  };
}
