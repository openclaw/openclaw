import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applySiliconFlowConfig, SILICONFLOW_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildSiliconFlowProvider } from "./provider-catalog.js";

const PROVIDER_ID = "siliconflow";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "SiliconFlow Provider",
  description: "Bundled SiliconFlow provider plugin",
  provider: {
    label: "SiliconFlow",
    docsPath: "/providers/siliconflow",
    auth: [
      {
        methodId: "api-key",
        label: "SiliconFlow API key",
        hint: "API key",
        optionKey: "siliconflowApiKey",
        flagName: "--siliconflow-api-key",
        envVar: "SILICONFLOW_API_KEY",
        promptMessage: "Enter SiliconFlow API key",
        defaultModel: SILICONFLOW_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applySiliconFlowConfig(cfg),
        wizard: {
          choiceId: "siliconflow-api-key",
          choiceLabel: "SiliconFlow API key",
          groupId: "siliconflow",
          groupLabel: "SiliconFlow",
          groupHint: "API key",
        },
      },
    ],
    catalog: {
      buildProvider: buildSiliconFlowProvider,
    },
    augmentModelCatalog: ({ config }) =>
      readConfiguredProviderCatalogEntries({
        config,
        providerId: PROVIDER_ID,
      }),
    matchesContextOverflowError: ({ errorMessage }) =>
      /\bsiliconflow\b.*(?:input.*too long|context.*exceed)/i.test(errorMessage),
  },
});
