// EvoLink plugin entrypoint registers its OpenClaw integration.
import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import { EVOLINK_DEFAULT_MODEL_REF } from "./models.js";
import { buildEvoLinkProvider } from "./provider-catalog.js";

const PROVIDER_ID = "evolink";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "EvoLink Provider",
  description: "Bundled EvoLink provider plugin",
  provider: {
    label: "EvoLink",
    docsPath: "/providers/models",
    envVars: ["EVOLINK_API_KEY"],
    preserveLiteralProviderPrefix: true,
    auth: [
      {
        methodId: "api-key",
        label: "EvoLink API key",
        hint: "OpenAI-compatible EvoLink endpoint",
        optionKey: "evolinkApiKey",
        flagName: "--evolink-api-key",
        envVar: "EVOLINK_API_KEY",
        promptMessage: "Enter EvoLink API key",
        defaultModel: EVOLINK_DEFAULT_MODEL_REF,
        noteTitle: "EvoLink",
        noteMessage: "Manage API keys at https://evolink.ai/dashboard",
      },
    ],
    catalog: {
      buildProvider: buildEvoLinkProvider,
      buildStaticProvider: buildEvoLinkProvider,
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
