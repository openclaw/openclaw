import { DEFAULT_CONTEXT_TOKENS } from "./defaults.js";

type ModelInput = "text" | "image";

export type CanonicalForwardCompatModelFacts = {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  input: readonly ModelInput[];
  contextWindow?: number;
  maxTokens?: number;
  fallbackContextWindow: number;
  fallbackMaxTokens: number;
  api: string;
  baseUrl: string;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  runtimeTemplateIds: readonly string[];
  catalogBaseModelId?: string;
};

type CatalogEntryLike = {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: Array<ModelInput>;
};

const OPENAI_CODEX_PROVIDER = "openai-codex";
const OPENAI_CODEX_GPT53_MODEL_ID = "gpt-5.3-codex";
const OPENAI_CODEX_GPT54_MODEL_ID = "gpt-5.4";
const OPENAI_CODEX_GPT53_SPARK_MODEL_ID = "gpt-5.3-codex-spark";
const OPENAI_CODEX_RUNTIME_TEMPLATE_MODEL_IDS = ["gpt-5.2-codex"] as const;
const OPENAI_CODEX_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const;

const CANONICAL_FORWARD_COMPAT_MODEL_FACTS: readonly CanonicalForwardCompatModelFacts[] = [
  {
    provider: OPENAI_CODEX_PROVIDER,
    id: OPENAI_CODEX_GPT53_MODEL_ID,
    name: OPENAI_CODEX_GPT53_MODEL_ID,
    reasoning: true,
    input: ["text", "image"],
    fallbackContextWindow: DEFAULT_CONTEXT_TOKENS,
    fallbackMaxTokens: DEFAULT_CONTEXT_TOKENS,
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
    cost: OPENAI_CODEX_DEFAULT_COST,
    runtimeTemplateIds: OPENAI_CODEX_RUNTIME_TEMPLATE_MODEL_IDS,
  },
  {
    provider: OPENAI_CODEX_PROVIDER,
    id: OPENAI_CODEX_GPT54_MODEL_ID,
    name: OPENAI_CODEX_GPT54_MODEL_ID,
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_050_000,
    maxTokens: 128_000,
    fallbackContextWindow: 1_050_000,
    fallbackMaxTokens: 128_000,
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
    cost: OPENAI_CODEX_DEFAULT_COST,
    runtimeTemplateIds: OPENAI_CODEX_RUNTIME_TEMPLATE_MODEL_IDS,
    catalogBaseModelId: OPENAI_CODEX_GPT53_MODEL_ID,
  },
  {
    provider: OPENAI_CODEX_PROVIDER,
    id: OPENAI_CODEX_GPT53_SPARK_MODEL_ID,
    name: OPENAI_CODEX_GPT53_SPARK_MODEL_ID,
    reasoning: true,
    input: ["text", "image"],
    fallbackContextWindow: DEFAULT_CONTEXT_TOKENS,
    fallbackMaxTokens: DEFAULT_CONTEXT_TOKENS,
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
    cost: OPENAI_CODEX_DEFAULT_COST,
    runtimeTemplateIds: OPENAI_CODEX_RUNTIME_TEMPLATE_MODEL_IDS,
    catalogBaseModelId: OPENAI_CODEX_GPT53_MODEL_ID,
  },
];

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

export function getCanonicalForwardCompatModelFacts(
  provider: string,
  modelId: string,
): CanonicalForwardCompatModelFacts | undefined {
  const normalizedProvider = normalizeKey(provider);
  const normalizedModelId = normalizeKey(modelId);
  return CANONICAL_FORWARD_COMPAT_MODEL_FACTS.find(
    (entry) => entry.provider === normalizedProvider && entry.id === normalizedModelId,
  );
}

export function applyCanonicalForwardCompatCatalogEntries<T extends CatalogEntryLike>(
  models: T[],
): void {
  for (const facts of CANONICAL_FORWARD_COMPAT_MODEL_FACTS) {
    if (!facts.catalogBaseModelId) {
      continue;
    }
    const hasExisting = models.some(
      (entry) =>
        normalizeKey(entry.provider) === facts.provider && normalizeKey(entry.id) === facts.id,
    );
    if (hasExisting) {
      continue;
    }

    const baseModel = models.find(
      (entry) =>
        normalizeKey(entry.provider) === facts.provider &&
        normalizeKey(entry.id) === facts.catalogBaseModelId,
    );
    if (!baseModel) {
      continue;
    }

    models.push({
      ...baseModel,
      id: facts.id,
      name: facts.name,
      reasoning: facts.reasoning,
      input: [...facts.input],
      ...(typeof facts.contextWindow === "number" ? { contextWindow: facts.contextWindow } : {}),
      ...(typeof facts.maxTokens === "number" ? { maxTokens: facts.maxTokens } : {}),
    } as T);
  }
}
