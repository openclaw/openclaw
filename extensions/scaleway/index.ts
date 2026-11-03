import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const PROVIDER_ID = "scaleway";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Scaleway Provider",
  description: "Scaleway Generative APIs provider plugin",
  manifest,
  provider: {
    label: "Scaleway",
    docsPath: "/providers/scaleway",
    manifestAuth: {
      noteTitle: "Scaleway",
      noteMessage:
        "Manage API keys at https://www.scaleway.com/en/docs/iam/credentials/create-api-keys/",
    },
    catalog: {
      discoveryMode: "strict",
      allowExplicitBaseUrl: true,
      liveModelDiscovery: true,
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
