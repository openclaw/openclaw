// Qwen provider module implements model/runtime integration.
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  QWEN_TOKEN_PLAN_GLOBAL_BASE_URL,
  QWEN_TOKEN_PLAN_MODEL_CATALOG,
  buildQwenModelCatalogForBaseUrl,
  buildQwenOAuthModelCatalog,
  QWEN_BASE_URL,
  QWEN_OAUTH_BASE_URL,
} from "./models.js";

export function buildQwenProvider(params?: { baseUrl?: string }): ModelProviderConfig {
  const baseUrl = params?.baseUrl ?? QWEN_BASE_URL;
  return {
    baseUrl,
    api: "openai-completions",
    models: buildQwenModelCatalogForBaseUrl(baseUrl).map((model) => Object.assign({}, model)),
  };
}

export function buildQwenOAuthProvider(): ModelProviderConfig {
  return {
    baseUrl: QWEN_OAUTH_BASE_URL,
    api: "openai-completions",
    models: buildQwenOAuthModelCatalog().map((model) => Object.assign({}, model)),
  };
}

export const buildModelStudioProvider = buildQwenProvider;

// Qwen Token Plan rides the OpenAI-compatible gateway — same transport as the
// rest of the qwen provider (Bearer auth, openai-completions, shared stream
// wrapper). The base URL is region-selected by the onboarding applier; the
// global Singapore gateway is the default.
export function buildQwenTokenPlanProvider(params?: { baseUrl?: string }): ModelProviderConfig {
  return {
    baseUrl: params?.baseUrl ?? QWEN_TOKEN_PLAN_GLOBAL_BASE_URL,
    api: "openai-completions",
    models: QWEN_TOKEN_PLAN_MODEL_CATALOG.map((model) => Object.assign({}, model)),
  };
}
