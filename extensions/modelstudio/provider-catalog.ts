import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-models";
import { MODELSTUDIO_BASE_URL, MODELSTUDIO_MODEL_CATALOG } from "./models.js";

export function buildModelStudioProvider(): ModelProviderConfig {
  return {
    baseUrl: MODELSTUDIO_BASE_URL,
    api: "openai-completions",
    models: MODELSTUDIO_MODEL_CATALOG.map((model) => ({ ...model })),
  };
}
