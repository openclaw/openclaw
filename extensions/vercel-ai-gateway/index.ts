import { runLiveProviderCatalog } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applyVercelAiGatewayConfig, VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import {
  buildStaticVercelAiGatewayProvider,
  buildVercelAiGatewayProvider,
  resolveVercelAiGatewayModel,
} from "./provider-catalog.js";
import { resolveVercelAiGatewayThinkingProfile } from "./thinking.js";

const PROVIDER_ID = "vercel-ai-gateway";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Vercel AI Gateway Provider",
  description: "Bundled Vercel AI Gateway provider plugin",
  manifest,
  provider: {
    label: "Vercel AI Gateway",
    docsPath: "/providers/vercel-ai-gateway",
    manifestAuth: {
      defaultModel: VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF,
      applyConfig: applyVercelAiGatewayConfig,
    },
    catalog: {
      run: async (ctx) => {
        const { apiKey, discoveryApiKey, profileId } = ctx.resolveProviderApiKey(PROVIDER_ID);
        if (!apiKey) {
          return null;
        }
        // The keyed list is account-scoped: a Token Pass key lists only its models.
        const run = async () => ({
          provider: {
            ...(await buildVercelAiGatewayProvider({ discoveryMode: "strict", discoveryApiKey })),
            apiKey,
          },
        });
        return await runLiveProviderCatalog({ providerId: PROVIDER_ID, profileId, run });
      },
      staticRun: async () => ({ provider: buildStaticVercelAiGatewayProvider() }),
    },
    resolveDynamicModel: ({ modelId }) => resolveVercelAiGatewayModel(modelId),
    resolveThinkingProfile: ({ modelId }) => resolveVercelAiGatewayThinkingProfile(modelId),
  },
});
