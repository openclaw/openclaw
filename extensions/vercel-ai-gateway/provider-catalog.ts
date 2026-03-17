import {
  discoverVercelAiGatewayModels,
  VERCEL_AI_GATEWAY_BASE_URL,
} from "../../src/agents/vercel-ai-gateway.js";
import type { ModelProviderConfig } from "../../src/config/types.models.js";

export async function buildVercelAiGatewayProvider(): Promise<ModelProviderConfig> {
  return {
    baseUrl: VERCEL_AI_GATEWAY_BASE_URL,
    api: "anthropic-messages",
    models: await discoverVercelAiGatewayModels(),
  };
}
