import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-models";
import { discoverVercelAiGatewayModels, VERCEL_AI_GATEWAY_BASE_URL } from "./api.js";

export async function buildVercelAiGatewayProvider(): Promise<ModelProviderConfig> {
  return {
    baseUrl: VERCEL_AI_GATEWAY_BASE_URL,
    api: "anthropic-messages",
    models: await discoverVercelAiGatewayModels(),
  };
}
