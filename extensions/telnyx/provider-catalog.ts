/** Telnyx static provider catalog builder. */
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { buildStaticTelnyxModels, TELNYX_BASE_URL } from "./models.js";

/** Builds Telnyx's network-free fallback provider catalog. */
export function buildStaticTelnyxProvider(): ModelProviderConfig {
  return {
    baseUrl: TELNYX_BASE_URL,
    api: "openai-completions",
    models: buildStaticTelnyxModels(),
  };
}
