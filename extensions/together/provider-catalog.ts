import {
  buildTogetherModelDefinition,
  TOGETHER_BASE_URL,
  TOGETHER_MODEL_CATALOG,
} from "../../src/agents/together-models.js";
import type { ModelProviderConfig } from "../../src/config/types.models.js";

export function buildTogetherProvider(): ModelProviderConfig {
  return {
    baseUrl: TOGETHER_BASE_URL,
    api: "openai-completions",
    models: TOGETHER_MODEL_CATALOG.map(buildTogetherModelDefinition),
  };
}
