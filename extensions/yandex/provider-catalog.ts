import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { buildYandexModelDefinition, YANDEX_BASE_URL, YANDEX_MODEL_CATALOG } from "./api.js";

export function buildYandexProvider(): ModelProviderConfig {
  return {
    baseUrl: YANDEX_BASE_URL,
    api: "openai-completions",
    models: YANDEX_MODEL_CATALOG.map(buildYandexModelDefinition),
  };
}
