import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { DINFERENCE_BASE_URL } from "./models.js";
import { applyDinferenceConfig, DINFERENCE_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildDinferenceProvider } from "./provider-catalog.js";

const PROVIDER_ID = "dinference";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "DInference Provider",
  description: "Bundled DInference provider plugin",
  provider: {
    label: "DInference",
    docsPath: "/providers/dinference",
    auth: [
      {
        methodId: "api-key",
        label: "DInference API key",
        hint: "Open source models (GLM-5, GLM-4.7, GPT-OSS-120B)",
        optionKey: "dinferenceApiKey",
        flagName: "--dinference-api-key",
        envVar: "DINFERENCE_API_KEY",
        promptMessage: "Enter DInference API key",
        defaultModel: DINFERENCE_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyDinferenceConfig(cfg),
        wizard: {
          groupLabel: "DInference",
        },
      },
    ],
    catalog: {
      buildProvider: buildDinferenceProvider,
    },
    augmentModelCatalog: () => {
      const providerCatalog = buildDinferenceProvider();
      const modelAllowlist = new Set(providerCatalog.models.map((m) => m.id));

      return providerCatalog.models.map((catalogModel) => ({
        id: catalogModel.id,
        name: catalogModel.name,
        provider: PROVIDER_ID,
        api: providerCatalog.api,
        baseUrl: DINFERENCE_BASE_URL,
        reasoning: catalogModel.reasoning,
        input: catalogModel.input,
        cost: catalogModel.cost,
        contextWindow: catalogModel.contextWindow,
        maxTokens: catalogModel.maxTokens,
        compat: catalogModel.compat,
        modelAllowlist: Array.from(modelAllowlist),
      }));
    },
  },
});
