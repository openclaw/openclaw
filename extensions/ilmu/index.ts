import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { applyIlmuConfig, ILMU_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildIlmuProvider } from "./provider-catalog.js";

const PROVIDER_ID = "ilmu";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "ILMU Provider",
  description: "Bundled ILMU provider plugin",
  provider: {
    label: "ILMU",
    docsPath: "/providers/ilmu",
    auth: [
      {
        methodId: "api-key",
        label: "ILMU API key",
        hint: "API key",
        optionKey: "ilmuApiKey",
        flagName: "--ilmu-api-key",
        envVar: "ILMU_API_KEY",
        promptMessage: "Enter ILMU API key",
        defaultModel: ILMU_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyIlmuConfig(cfg),
        wizard: {
          choiceId: "ilmu-api-key",
          choiceLabel: "ILMU API key",
          groupId: "ilmu",
          groupLabel: "ILMU",
          groupHint: "API key",
        },
      },
    ],
    catalog: {
      buildProvider: buildIlmuProvider,
    },
    augmentModelCatalog: ({ config }) =>
      readConfiguredProviderCatalogEntries({
        config,
        providerId: PROVIDER_ID,
      }),
    ...buildProviderReplayFamilyHooks({ family: "openai-compatible" }),
  },
});
