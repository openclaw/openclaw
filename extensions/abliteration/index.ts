import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { createProviderConnectionPresetAppliers } from "openclaw/plugin-sdk/provider-onboard";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import { ABLITERATION_DEFAULT_MODEL_REF, buildAbliterationProvider } from "./models.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const PROVIDER_ID = "abliteration";
const abliterationProvider = buildAbliterationProvider();

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Abliteration Provider",
  description: "Abliteration provider plugin",
  manifest,
  provider: {
    label: "Abliteration",
    docsPath: "/providers/abliteration",
    envVars: ["ABLITERATION_API_KEY", "ABLIT_KEY"],
    manifestAuth: {
      defaultModel: ABLITERATION_DEFAULT_MODEL_REF,
      applyConfig: createProviderConnectionPresetAppliers<[]>({
        primaryModelRef: ABLITERATION_DEFAULT_MODEL_REF,
        resolveParams: () => ({
          providerId: "abliteration",
          api: "openai-completions",
          baseUrl: abliterationProvider.baseUrl,
          catalogModels: () => abliterationProvider.models,
          aliases: [{ modelRef: ABLITERATION_DEFAULT_MODEL_REF, alias: "Abliterated Large Flash" }],
        }),
      }).applyConfig,
      noteTitle: "Abliteration",
      noteMessage: "Create an API key at https://abliteration.ai.",
    },
    catalog: {},
    augmentModelCatalog: ({ config }) =>
      readConfiguredProviderCatalogEntries({ config, providerId: PROVIDER_ID }),
    ...buildProviderReplayFamilyHooks({
      family: "openai-compatible",
      dropReasoningFromHistory: false,
    }),
    ...buildProviderToolCompatFamilyHooks("openai"),
    isModernModelRef: () => true,
  },
});
