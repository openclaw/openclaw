import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";

/**
 * Yandex AI Studio OpenAI-compatible API base URL.
 *
 * The chat completions endpoint lives at `${YANDEX_BASE_URL}/chat/completions`.
 * @see https://yandex.cloud/en/docs/ai-studio/quickstart/yandexgpt
 */
export const YANDEX_BASE_URL = "https://llm.api.cloud.yandex.net/v1";

/**
 * YandexGPT model catalog.
 *
 * Model IDs here are bare names (without folder prefix). At request time they
 * are sent as `gpt://<folder_ID>/<model_id>` — the folder ID is supplied via
 * the `OpenAI-Project` header (the `project` field in the OpenAI SDK).
 *
 * @see https://yandex.cloud/en/docs/ai-studio/text-generation/api-ref/TextGeneration/completion
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
