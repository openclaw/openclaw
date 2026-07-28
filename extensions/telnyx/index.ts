/** Telnyx provider plugin entrypoint. */
import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import { projectTelnyxLiveModels, resolveTelnyxDynamicModel } from "./models.js";
import { applyTelnyxConfig } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { buildStaticTelnyxProvider } from "./provider-catalog.js";

const PROVIDER_ID = "telnyx";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Telnyx Provider",
  description: "Official Telnyx AI inference provider plugin",
  manifest,
  provider: {
    label: "Telnyx",
    docsPath: "/providers/telnyx",
    manifestAuth: {
      applyConfig: applyTelnyxConfig,
      noteTitle: "Telnyx",
      noteMessage: [
        "Telnyx serves open-weight and proxied frontier models behind one OpenAI-compatible API.",
        "Create an API key at: https://portal.telnyx.com/#/app/api-keys",
      ].join("\n"),
    },
    catalog: {
      buildProvider: buildStaticTelnyxProvider,
      buildStaticProvider: buildStaticTelnyxProvider,
      allowExplicitBaseUrl: true,
      liveModelDiscovery: {
        timeoutMs: 10_000,
        ttlMs: 5 * 60 * 1000,
        projectRows: projectTelnyxLiveModels,
      },
    },
    augmentModelCatalog: ({ config }) =>
      readConfiguredProviderCatalogEntries({
        config,
        providerId: PROVIDER_ID,
      }),
    resolveDynamicModel: ({ modelId }) => resolveTelnyxDynamicModel(modelId),
    ...buildProviderReplayFamilyHooks({
      family: "openai-compatible",
      dropReasoningFromHistory: false,
    }),
    ...buildProviderToolCompatFamilyHooks("openai"),
  },
});
