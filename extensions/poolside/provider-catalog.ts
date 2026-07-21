/** Poolside static provider catalog builders. */
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { buildStaticPoolsideModels, POOLSIDE_BASE_URL } from "./models.js";

/** Builds Poolside's static Laguna provider catalog. */
export function buildPoolsideProvider(): ModelProviderConfig {
  return {
    baseUrl: POOLSIDE_BASE_URL,
    api: "openai-completions",
    models: buildStaticPoolsideModels(),
  };
}
