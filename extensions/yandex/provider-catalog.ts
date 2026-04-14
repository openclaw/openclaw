import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { buildYandexModelDefinition, YANDEX_BASE_URL, YANDEX_MODEL_CATALOG } from "./api.js";

/**
 * Build the Yandex provider config.
 *
 * `folderId` is passed as the `OpenAI-Project` header, which the Yandex AI
 * Studio endpoint uses to resolve folder-scoped model URIs.
 *
 * @see https://aistudio.yandex.ru/docs/en/ai-studio/quickstart/index.html
 */
export function buildYandexProvider(folderId?: string): ModelProviderConfig {
  return {
    baseUrl: YANDEX_BASE_URL,
    api: "openai-completions",
    ...(folderId ? { headers: { "OpenAI-Project": folderId } } : {}),
    models: YANDEX_MODEL_CATALOG.map(buildYandexModelDefinition),
  };
}
