/**
 * Manifest provider plugin entrypoint.
 */
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applyManifestConfig, MANIFEST_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildManifestProvider } from "./provider-catalog.js";

const PROVIDER_ID = "manifest";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Manifest Provider",
  description: "Bundled Manifest LLM router provider plugin",
  provider: {
    label: "Manifest",
    docsPath: "/providers/manifest",
    auth: [
      {
        methodId: "api-key",
        label: "Manifest API key",
        hint: "Open-source LLM router with smart routing across 16+ providers",
        optionKey: "manifestApiKey",
        flagName: "--manifest-api-key",
        envVar: "MANIFEST_API_KEY",
        promptMessage: "Enter Manifest API key (mnfst_...)",
        defaultModel: MANIFEST_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyManifestConfig(cfg),
        noteMessage: [
          "Manifest is an open-source LLM router that cuts inference costs through smart routing across 16+ providers.",
          "You get full control over which model handles each request. Can be self-hosted for fully private inference.",
          "Get your API key at: https://manifest.build",
        ].join("\n"),
        noteTitle: "Manifest",
        wizard: {
          groupLabel: "Manifest",
          groupHint: "Open-source LLM router with smart routing across 16+ providers",
        },
      },
    ],
    catalog: {
      buildProvider: buildManifestProvider,
      buildStaticProvider: buildManifestProvider,
    },
  },
});
