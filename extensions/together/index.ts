import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applyModelCompatPatch } from "openclaw/plugin-sdk/provider-model-shared";
import { applyTogetherConnectionConfig } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { buildTogetherVideoGenerationProvider } from "./video-generation-provider.js";

const PROVIDER_ID = "together";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Together Provider",
  description: "Bundled Together provider plugin",
  manifest,
  provider: {
    label: "Together",
    docsPath: "/providers/together",
    manifestAuth: { applyConfig: applyTogetherConnectionConfig },
    catalog: { liveModelDiscovery: true, discoveryMode: "strict" },
    normalizeResolvedModel: ({ model }) =>
      model.api === "openai-completions" &&
      ["https://api.together.xyz/v1", "https://api.together.ai/v1"].includes(
        model.baseUrl.trim().replace(/\/+$/u, ""),
      )
        ? applyModelCompatPatch(model, {
            supportsPromptCacheKey: model.compat?.supportsPromptCacheKey ?? true,
            supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? false,
          })
        : model,
    classifyFailoverReason: ({ errorMessage }) =>
      /\bconcurrency limit\b.*\b(?:breached|reached)\b/i.test(errorMessage)
        ? "rate_limit"
        : undefined,
  },
  register(api) {
    api.registerVideoGenerationProvider(buildTogetherVideoGenerationProvider());
  },
});
