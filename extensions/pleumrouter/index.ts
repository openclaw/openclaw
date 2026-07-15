import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import { PLEUMROUTER_DEFAULT_MODEL_REF } from "./models.js";
import { buildPleumrouterProvider } from "./provider-catalog.js";

const PROVIDER_ID = "pleumrouter";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "PleumRouter Provider",
  description: "Bundled PleumRouter provider plugin",
  provider: {
    label: "PleumRouter",
    docsPath: "/providers/pleumrouter",
    aliases: ["pleum", "pleum-router"],
    envVars: ["PLEUMROUTER_API_KEY"],
    auth: [
      {
        methodId: "api-key",
        label: "PleumRouter API key",
        hint: "Korea-region OpenAI-compatible multi-provider gateway",
        optionKey: "pleumrouterApiKey",
        flagName: "--pleumrouter-api-key",
        envVar: "PLEUMROUTER_API_KEY",
        promptMessage: "Enter PleumRouter API key",
        defaultModel: PLEUMROUTER_DEFAULT_MODEL_REF,
        noteTitle: "PleumRouter",
        noteMessage: "Manage API keys at https://router.pleum.ai (Dashboard → API Keys)",
      },
    ],
    catalog: {
      buildProvider: buildPleumrouterProvider,
      buildStaticProvider: buildPleumrouterProvider,
      allowExplicitBaseUrl: true,
    },
    augmentModelCatalog: ({ config }) =>
      readConfiguredProviderCatalogEntries({
        config,
        providerId: PROVIDER_ID,
      }),
    ...buildProviderReplayFamilyHooks({
      family: "openai-compatible",
      dropReasoningFromHistory: false,
    }),
    ...buildProviderToolCompatFamilyHooks("openai"),
  },
});
