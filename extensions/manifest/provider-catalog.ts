/**
 * Manifest model provider builder.
 */
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { buildManifestCatalogModels, MANIFEST_BASE_URL } from "./models.js";

/** Builds the Manifest OpenAI-compatible model provider config. */
export function buildManifestProvider(): ModelProviderConfig {
  return {
    baseUrl: MANIFEST_BASE_URL,
    api: "openai-completions",
    models: buildManifestCatalogModels(),
  };
}
