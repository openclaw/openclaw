import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { buildIlmuModelDefinition, ILMU_BASE_URL, ILMU_MODEL_CATALOG } from "./models.js";

export function buildIlmuProvider(): ModelProviderConfig {
  return {
    baseUrl: ILMU_BASE_URL,
    api: "openai-completions",
    models: ILMU_MODEL_CATALOG.map(buildIlmuModelDefinition),
  };
}
