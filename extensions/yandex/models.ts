import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";

/**
 * Yandex AI Studio OpenAI-compatible API base URL.
 *
 * The chat completions endpoint lives at `${YANDEX_BASE_URL}/chat/completions`.
 * @see https://aistudio.yandex.ru/docs/en/ai-studio/quickstart/index.html
 */
export const YANDEX_BASE_URL = "https://llm.api.cloud.yandex.net/v1";

/**
 * Build a folder-scoped Yandex model URI.
 *
 * Yandex AI Studio's OpenAI-compatible endpoint requires model IDs in the form
 * `gpt://<folder_ID>/<model_name>`. The folder ID is passed separately as the
 * `project` parameter (OpenAI SDK) which maps to the `OpenAI-Project` header.
 *
 * @see https://aistudio.yandex.ru/docs/en/ai-studio/concepts/generation/models.html
 */
export function buildYandexModelUri(folderId: string, modelName: string): string {
  return `gpt://${folderId}/${modelName}`;
}

/**
 * Yandex AI Studio model names (without folder prefix).
 *
 * @see https://aistudio.yandex.ru/docs/en/ai-studio/concepts/generation/models.html
 */
export const YANDEX_MODEL_NAMES = {
  PRO_5_1: "yandexgpt-5.1",
  PRO_5: "yandexgpt-5-pro",
  LITE_5: "yandexgpt-5-lite",
} as const;

/**
 * YandexGPT model catalog.
 *
 * Model IDs here are bare names (without folder prefix). The folder ID is
 * configured separately via `YANDEX_FOLDER_ID` and injected at request time
 * via the `OpenAI-Project` header (the `project` field in the OpenAI SDK).
 *
 * Pricing is per 1 M tokens (approximate, subject to change).
 * @see https://aistudio.yandex.ru/docs/en/ai-studio/concepts/generation/models.html
 * @see https://yandex.cloud/en/docs/foundation-models/pricing
 */
export const YANDEX_MODEL_CATALOG: ModelDefinitionConfig[] = [
  {
    id: YANDEX_MODEL_NAMES.PRO_5_1,
    name: "YandexGPT Pro 5.1",
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
    id: YANDEX_MODEL_NAMES.PRO_5,
    name: "YandexGPT Pro 5",
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
    id: YANDEX_MODEL_NAMES.LITE_5,
    name: "YandexGPT Lite 5",
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
