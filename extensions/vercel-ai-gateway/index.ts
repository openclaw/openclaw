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
      discoveryMode: "strict",
      buildProvider: () => buildVercelAiGatewayProvider({ discoveryMode: "strict" }),
      buildStaticProvider: buildStaticVercelAiGatewayProvider,
    },
    resolveDynamicModel: ({ modelId }) => resolveVercelAiGatewayModel(modelId),
    resolveThinkingProfile: ({ modelId }) => resolveVercelAiGatewayThinkingProfile(modelId),
    classifyFailoverReason: ({ provider, status, errorMessage }) => {
      if (provider?.trim().toLowerCase() !== PROVIDER_ID || status !== 403) {
        return undefined;
      }
      // Token Pass uses the same status and error type for credit and model scope
      // failures. Only the documented message distinguishes their cooldown scope.
      if (/\bVercel Token Pass credits are used up\b/i.test(errorMessage)) {
        return "billing";
      }
      if (
        /\bscoped to Vercel Token Pass and can only be used with Token Pass models\b/i.test(
          errorMessage,
        )
      ) {
        return "model_not_found";
      }
      return undefined;
    },
  },
});
