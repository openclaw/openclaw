import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";

/**
 * Yandex AI Studio OpenAI-compatible API base URL.
 *
 * The chat completions endpoint lives at `${YANDEX_BASE_URL}/chat/completions`.
 * @see https://aistudio.yandex.ru/docs/ai-studio/concepts/api#openai
 */
export const YANDEX_BASE_URL = "https://llm.api.cloud.yandex.net/v1";

/**
 * YandexGPT model catalog.
 *
 * Model IDs match the identifiers accepted by the Yandex AI Studio
 * OpenAI-compatible chat completions endpoint.
 *
 * Pricing is per 1 M tokens (approximate, subject to change).
 * @see https://aistudio.yandex.ru/docs/ai-studio/concepts/generation/models
 * @see https://yandex.cloud/en/docs/foundation-models/pricing
 */
export const YANDEX_MODEL_CATALOG: ModelDefinitionConfig[] = [
  {
    id: "yandexgpt/latest",
    name: "YandexGPT Pro",
    reasoning: false,
    input: ["text"],
    contextWindow: 32768,
    maxTokens: 8192,
    cost: {
      input: 1.2,
      output: 1.2,
      cacheRead: 0,
      cacheWrite: 0,
    },
  },
  {
    id: "yandexgpt/rc",
    name: "YandexGPT Pro RC",
    reasoning: false,
    input: ["text"],
    contextWindow: 32768,
    maxTokens: 8192,
    cost: {
      input: 1.2,
      output: 1.2,
      cacheRead: 0,
      cacheWrite: 0,
    },
  },
  {
    id: "yandexgpt-lite/latest",
    name: "YandexGPT Lite",
    reasoning: false,
    input: ["text"],
    contextWindow: 32768,
    maxTokens: 8192,
    cost: {
      input: 0.2,
      output: 0.2,
      cacheRead: 0,
      cacheWrite: 0,
    },
  },
];

export function buildYandexModelDefinition(
  model: (typeof YANDEX_MODEL_CATALOG)[number],
): ModelDefinitionConfig {
  return {
    ...model,
    api: "openai-completions",
  };
}
