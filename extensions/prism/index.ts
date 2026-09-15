// Prism plugin entrypoint registers its OpenClaw integration.
import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const PROVIDER_ID = "prism";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Prism Provider",
  description: "Official OpenClaw Prism provider plugin",
  manifest,
  provider: {
    label: "Prism",
    docsPath: "/providers/prism",
    manifestAuth: {
      noteTitle: "Prism",
      noteMessage: "Manage API keys at https://prisminference.com/app/settings/api-keys",
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
