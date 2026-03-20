import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-models";
import {
  buildFeatherlessModelDefinition,
  FEATHERLESS_BASE_URL,
  FEATHERLESS_MODEL_CATALOG,
} from "./models.js";

export function buildFeatherlessProvider(): ModelProviderConfig {
  return {
    baseUrl: FEATHERLESS_BASE_URL,
    api: "openai-completions",
    models: FEATHERLESS_MODEL_CATALOG.map(buildFeatherlessModelDefinition),
  };
}
