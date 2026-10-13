import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applyModelCompatPatch } from "openclaw/plugin-sdk/provider-model-shared";
import { applyCerebrasConfig } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { CEREBRAS_MODEL_DISCOVERY } from "./provider-catalog.js";

const PROVIDER_ID = "cerebras";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Cerebras Provider",
  description: "Bundled Cerebras provider plugin",
  manifest,
  provider: {
    label: "Cerebras",
    docsPath: "/providers/cerebras",
    manifestAuth: {
      preserveExistingPrimary: true,
      applyConfig: applyCerebrasConfig,
      noteMessage: [
        "Cerebras provides high-speed OpenAI-compatible inference for GPT OSS and GLM models.",
        "Get your API key at: https://cloud.cerebras.ai",
      ].join("\n"),
      noteTitle: "Cerebras",
    },
    catalog: {
      discoveryMode: "strict",
      allowExplicitBaseUrl: true,
      liveModelDiscovery: CEREBRAS_MODEL_DISCOVERY,
    },
    normalizeResolvedModel: ({ model }) =>
      model.api === "openai-completions" &&
      model.baseUrl.trim().replace(/\/+$/u, "") === "https://api.cerebras.ai/v1"
        ? applyModelCompatPatch(model, {
            supportsPromptCacheKey: model.compat?.supportsPromptCacheKey ?? true,
            supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? false,
          })
        : model,
  },
});
