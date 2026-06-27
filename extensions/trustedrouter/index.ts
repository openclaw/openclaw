/**
 * TrustedRouter provider plugin entrypoint.
 */
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applyTrustedRouterConfig, TRUSTEDROUTER_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildTrustedRouterProvider } from "./provider-catalog.js";

const PROVIDER_ID = "trustedrouter";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "TrustedRouter Provider",
  description: "Bundled TrustedRouter provider plugin",
  provider: {
    label: "TrustedRouter",
    docsPath: "/providers/trustedrouter",
    auth: [
      {
        methodId: "api-key",
        label: "TrustedRouter API key",
        hint: "Attested, privacy-preserving frontier model routing",
        optionKey: "trustedrouterApiKey",
        flagName: "--trustedrouter-api-key",
        envVar: "TRUSTEDROUTER_API_KEY",
        promptMessage: "Enter TrustedRouter API key",
        defaultModel: TRUSTEDROUTER_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyTrustedRouterConfig(cfg),
        noteMessage: [
          "TrustedRouter provides attested, privacy-preserving routing to frontier models (Claude, GPT, Gemini, and more).",
          "Get your API key at: https://trustedrouter.com",
        ].join("\n"),
        noteTitle: "TrustedRouter",
        wizard: {
          groupLabel: "TrustedRouter",
          groupHint: "Attested, privacy-preserving frontier model routing",
        },
      },
    ],
    catalog: {
      buildProvider: buildTrustedRouterProvider,
      buildStaticProvider: buildTrustedRouterProvider,
    },
  },
});
