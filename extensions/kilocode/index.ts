import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { buildKilocodeProviderWithDiscovery } from "../../src/agents/models-config.providers.discovery.js";
import {
  createKilocodeWrapper,
  isProxyReasoningUnsupported,
} from "../../src/agents/pi-embedded-runner/proxy-stream-wrappers.js";

const PROVIDER_ID = "kilocode";

const kilocodePlugin = {
  id: PROVIDER_ID,
  name: "Kilo Gateway Provider",
  description: "Bundled Kilo Gateway provider plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Kilo Gateway",
      docsPath: "/providers/kilocode",
      envVars: ["KILOCODE_API_KEY"],
      auth: [],
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
          if (!apiKey) {
            return null;
          }
          return {
            provider: {
              ...(await buildKilocodeProviderWithDiscovery()),
              apiKey,
            },
          };
        },
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
    });
  },
};

export default kilocodePlugin;
