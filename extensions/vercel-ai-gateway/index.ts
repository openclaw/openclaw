import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import { buildSingleProviderApiKeyCatalog } from "openclaw/plugin-sdk/provider-catalog";
import { applyVercelAiGatewayConfig, VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildVercelAiGatewayProvider } from "./provider-catalog.js";

const PROVIDER_ID = "vercel-ai-gateway";

const vercelAiGatewayPlugin = {
  id: PROVIDER_ID,
  name: "Vercel AI Gateway Provider",
  description: "Bundled Vercel AI Gateway provider plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Vercel AI Gateway",
      docsPath: "/providers/vercel-ai-gateway",
      envVars: ["AI_GATEWAY_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "Vercel AI Gateway API key",
          hint: "API key",
          optionKey: "aiGatewayApiKey",
          flagName: "--ai-gateway-api-key",
          envVar: "AI_GATEWAY_API_KEY",
          promptMessage: "Enter Vercel AI Gateway API key",
          defaultModel: VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF,
          expectedProviders: ["vercel-ai-gateway"],
          applyConfig: (cfg) => applyVercelAiGatewayConfig(cfg),
          wizard: {
            choiceId: "ai-gateway-api-key",
            choiceLabel: "Vercel AI Gateway API key",
            groupId: "ai-gateway",
            groupLabel: "Vercel AI Gateway",
            groupHint: "API key",
          },
        }),
      ],
      catalog: {
        order: "simple",
        run: (ctx) =>
          buildSingleProviderApiKeyCatalog({
            ctx,
            providerId: PROVIDER_ID,
            buildProvider: buildVercelAiGatewayProvider,
          }),
      },
    });
  },
};

export default vercelAiGatewayPlugin;
