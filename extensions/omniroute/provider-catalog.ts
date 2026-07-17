// OmniRoute provider catalog for the bundled OpenAI-compatible proxy plugin.
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  buildOmniRouteDefaultModel,
  OMNIROUTE_DEFAULT_BASE_URL,
} from "./models.js";

export function buildOmniRouteProvider(): ModelProviderConfig {
  return {
    baseUrl: OMNIROUTE_DEFAULT_BASE_URL,
    api: "openai-completions",
    models: [buildOmniRouteDefaultModel()],
  };
}
