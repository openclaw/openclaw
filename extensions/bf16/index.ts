import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { createProviderConnectionPresetAppliers } from "openclaw/plugin-sdk/provider-onboard";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import { BF16_DEFAULT_MODEL_REF, buildBf16Provider } from "./models.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const PROVIDER_ID = "bf16";
const bf16Provider = buildBf16Provider();

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "bf16.ai Provider",
  description: "bf16.ai provider plugin",
  manifest,
  provider: {
    label: "bf16.ai",
    docsPath: "/providers/bf16",
    envVars: ["BF16_API_KEY"],
    manifestAuth: {
      defaultModel: BF16_DEFAULT_MODEL_REF,
      applyConfig: createProviderConnectionPresetAppliers<[]>({
        primaryModelRef: BF16_DEFAULT_MODEL_REF,
        resolveParams: () => ({
          providerId: PROVIDER_ID,
          api: "openai-completions",
          baseUrl: bf16Provider.baseUrl,
          catalogModels: () => bf16Provider.models,
          aliases: [
            {
              modelRef: BF16_DEFAULT_MODEL_REF,
              alias: "DeepSeek V4.1 Flash (Uncensored)",
            },
          ],
        }),
      }).applyConfig,
      noteTitle: "bf16.ai",
      noteMessage: "Create an API key at https://bf16.ai/dashboard/keys.",
    },
    catalog: {
      discoveryMode: "strict",
      allowExplicitBaseUrl: true,
      // https://api.bf16.ai/v1/models is a public catalog endpoint; avoid sending inference credentials.
      liveModelDiscovery: {
        authentication: "none",
      },
    },
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
