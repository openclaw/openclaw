import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { createProviderConnectionPresetAppliers } from "openclaw/plugin-sdk/provider-onboard";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import { buildNodecodeProvider, NODECODE_DEFAULT_MODEL_REF } from "./models.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const PROVIDER_ID = "nodecode";
const nodecodeProvider = buildNodecodeProvider();

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Nodecode Provider",
  description: "Nodecode provider plugin",
  manifest,
  provider: {
    label: "Nodecode",
    docsPath: "/providers/nodecode",
    envVars: ["NODECODE_API_KEY"],
    manifestAuth: {
      defaultModel: NODECODE_DEFAULT_MODEL_REF,
      // Signing in again, or adding Nodecode beside another provider, keeps the
      // primary model the user already chose; only a config without one gets Cyber v1.
      preserveExistingPrimary: true,
      applyConfig: createProviderConnectionPresetAppliers<[]>({
        primaryModelRef: NODECODE_DEFAULT_MODEL_REF,
        resolveParams: () => ({
          providerId: PROVIDER_ID,
          api: "openai-completions",
          baseUrl: nodecodeProvider.baseUrl,
          catalogModels: () => nodecodeProvider.models,
          aliases: [{ modelRef: NODECODE_DEFAULT_MODEL_REF, alias: "Cyber v1" }],
        }),
      }).applyConfig,
      noteTitle: "Nodecode",
      noteMessage: [
        "Cyber v1 is Nodecode's abliterated model for security work.",
        "Create an API key at https://nodecode.ai/account/keys and top up a balance to call it.",
      ].join("\n"),
    },
    catalog: {
      discoveryMode: "strict",
      allowExplicitBaseUrl: true,
      // The account's model list also names non-chat models (Decide v1 classifies,
      // Image v1 draws); rows without chat evidence stay out of default pickers.
      liveModelDiscovery: { unknownModelChatEvidence: "unlikely" },
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
