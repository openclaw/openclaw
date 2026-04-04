import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import {
  createKilocodeWrapper,
  isProxyReasoningUnsupported,
} from "openclaw/plugin-sdk/provider-stream";
import { applyKilocodeConfig, KILOCODE_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildKilocodeProviderWithDiscovery } from "./provider-catalog.js";

const PROVIDER_ID = "kilocode";
const PASSTHROUGH_GEMINI_REPLAY_HOOKS = buildProviderReplayFamilyHooks({
  family: "passthrough-gemini",
});

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
    ...PASSTHROUGH_GEMINI_REPLAY_HOOKS,
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
