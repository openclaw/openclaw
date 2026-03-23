import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import {
  createKilocodeWrapper,
  isProxyReasoningUnsupported,
} from "../../src/agents/pi-embedded-runner/proxy-stream-wrappers.js";
import { createProviderApiKeyAuthMethod } from "../../src/plugins/provider-api-key-auth.js";
import { buildSingleProviderApiKeyCatalog } from "../../src/plugins/provider-catalog.js";
import { applyKilocodeConfig, KILOCODE_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildKilocodeProviderWithDiscovery } from "./provider-catalog.js";

const PROVIDER_ID = "kilocode";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Kilo Gateway Provider",
  description: "Bundled Kilo Gateway provider plugin",
  provider: {
    label: "Kilo Gateway",
    docsPath: "/providers/kilocode",
    auth: [
      {
        methodId: "api-key",
        label: "Kilo Gateway API key",
        hint: "API key (OpenRouter-compatible)",
        optionKey: "kilocodeApiKey",
        flagName: "--kilocode-api-key",
        envVar: "KILOCODE_API_KEY",
        promptMessage: "Enter Kilo Gateway API key",
        defaultModel: KILOCODE_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyKilocodeConfig(cfg),
      },
    ],
    catalog: {
      buildProvider: buildKilocodeProviderWithDiscovery,
    },
    capabilities: {
      geminiThoughtSignatureSanitization: true,
      geminiThoughtSignatureModelHints: ["gemini"],
    },
    wrapStreamFn: (ctx) => {
      const thinkingLevel =
        ctx.modelId === "kilo/auto" || isProxyReasoningUnsupported(ctx.modelId)
          ? undefined
          : ctx.thinkingLevel;
      return createKilocodeWrapper(ctx.streamFn, thinkingLevel);
    },
    isCacheTtlEligible: (ctx) => ctx.modelId.startsWith("anthropic/"),
  },
});
