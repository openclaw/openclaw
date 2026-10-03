import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { FLEXAI_MODEL_DISCOVERY } from "./provider-catalog.js";

const PROVIDER_ID = "flexai";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "FlexAI Provider",
  description: "Bundled FlexAI provider plugin",
  manifest,
  provider: {
    label: "FlexAI",
    docsPath: "/providers/flexai",
    manifestAuth: {
      noteTitle: "FlexAI",
      noteMessage: [
        "FlexAI serves open-weight models behind an OpenAI-compatible API.",
        "Create an API key at: https://flex.ai",
      ].join("\n"),
    },
    catalog: {
      discoveryMode: "strict",
      allowExplicitBaseUrl: true,
      liveModelDiscovery: FLEXAI_MODEL_DISCOVERY,
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
