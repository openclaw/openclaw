import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  buildGmicloudModelDefinition,
  GMICLOUD_BASE_URL,
  GMICLOUD_MODEL_CATALOG,
} from "./models.js";

export function buildGmicloudProvider(): ModelProviderConfig {
  return {
    baseUrl: GMICLOUD_BASE_URL,
    api: "openai-completions",
    models: GMICLOUD_MODEL_CATALOG.map(buildGmicloudModelDefinition),
  };
}
