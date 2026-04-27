import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

export function buildNvidiaProvider(): ModelProviderConfig {
  return {
    ...buildManifestModelProviderConfig({
      providerId: "nvidia",
      catalog: manifest.modelCatalog.providers.nvidia,
    }),
    // Bare env-var name — resolveUsableCustomProviderApiKey resolves it to
    // process.env.NVIDIA_API_KEY at infer time. Without this field,
    // pi-coding-agent's models.json validateConfig() rejects the entire file.
    // The shared manifest helper does not pass through apiKey today, so we
    // spread its result and tack the marker on. See #73013.
    apiKey: "NVIDIA_API_KEY",
  };
}
