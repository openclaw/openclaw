import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { BASETEN_BASE_URL, buildStaticBasetenModels } from "./models.js";

export function buildStaticBasetenProvider(): ModelProviderConfig {
  return {
    baseUrl: BASETEN_BASE_URL,
    api: "openai-completions",
    models: buildStaticBasetenModels(),
  };
}
