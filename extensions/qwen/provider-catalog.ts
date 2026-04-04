import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { QWEN_BASE_URL, QWEN_MODEL_CATALOG } from "./models.js";

export function buildQwenProvider(): ModelProviderConfig {
  return {
    baseUrl: QWEN_BASE_URL,
    api: "openai-completions",
    models: QWEN_MODEL_CATALOG.map((model) => ({ ...model })),
  };
}

export const buildModelStudioProvider = buildQwenProvider;
