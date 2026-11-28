import type { ImageGenerationProvider } from "openclaw/plugin-sdk/image-generation";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { OPENAI_DEFAULT_IMAGE_MODEL } from "./default-models.js";
import { buildOpenAIImageCapabilities, OPENAI_IMAGE_MODELS } from "./image-generation-models.js";

export type OpenAIImageModelAuth = Pick<
  OpenClawPluginApi["runtime"]["modelAuth"],
  "ensureAuthProfileStoreAsync" | "listProfilesForProvider" | "isProviderApiKeyConfiguredAsync"
>;

export function buildOpenAIImageGenerationProvider(
  modelAuth: OpenAIImageModelAuth,
): ImageGenerationProvider {
  // Each registration owns its auth bindings, even when registrations share the imported module.
  const loadRuntime = createLazyRuntimeModule(async () => {
    const { buildOpenAIImageGenerationRuntime } =
      await import("./image-generation-provider.runtime.js");
    return buildOpenAIImageGenerationRuntime(modelAuth);
  });
  return {
    id: "openai",
    label: "OpenAI",
    defaultModel: OPENAI_DEFAULT_IMAGE_MODEL,
    models: [...OPENAI_IMAGE_MODELS],
    capabilities: buildOpenAIImageCapabilities(),
    isConfiguredAsync: async (params) => (await loadRuntime()).isConfiguredAsync(params),
    generateImage: async (req) => (await loadRuntime()).generateImage(req),
  };
}
