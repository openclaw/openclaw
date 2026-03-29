import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applyXaiModelCompat } from "openclaw/plugin-sdk/xai";
import { createVeniceE2EEStreamWrapper, isVeniceE2EEModel } from "./e2ee-stream-wrapper.js";
import { applyVeniceConfig, VENICE_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildVeniceProvider } from "./provider-catalog.js";

const PROVIDER_ID = "venice";

function isXaiBackedVeniceModel(modelId: string): boolean {
  return modelId.trim().toLowerCase().includes("grok");
}

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Venice Provider",
  description: "Bundled Venice provider plugin",
  provider: {
    label: "Venice",
    docsPath: "/providers/venice",
    auth: [
      {
        methodId: "api-key",
        label: "Venice AI API key",
        hint: "Privacy-focused (uncensored models)",
        optionKey: "veniceApiKey",
        flagName: "--venice-api-key",
        envVar: "VENICE_API_KEY",
        promptMessage: "Enter Venice AI API key",
        defaultModel: VENICE_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyVeniceConfig(cfg),
        noteMessage: [
          "Venice AI provides privacy-focused inference with uncensored models.",
          "Get your API key at: https://venice.ai/settings/api",
          "Supports 'private' (fully private) and 'anonymized' (proxy) modes.",
        ].join("\n"),
        noteTitle: "Venice AI",
        wizard: {
          groupLabel: "Venice AI",
        },
      },
    ],
    catalog: {
      buildProvider: buildVeniceProvider,
    },
    wrapStreamFn: (ctx) => {
      if (!isVeniceE2EEModel(ctx.modelId)) return undefined;
      return createVeniceE2EEStreamWrapper(ctx.streamFn);
    },
    normalizeResolvedModel: ({ modelId, model }) =>
      isXaiBackedVeniceModel(modelId) ? applyXaiModelCompat(model) : undefined,
  },
});
