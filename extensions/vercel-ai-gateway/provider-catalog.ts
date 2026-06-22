// Vercel Ai Gateway provider module implements model/runtime integration.
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  discoverVercelAiGatewayModels,
  getStaticVercelAiGatewayModelCatalog,
  resolveVercelAiGatewayDynamicModel,
  VERCEL_AI_GATEWAY_BASE_URL,
  VERCEL_AI_GATEWAY_PROVIDER_ID,
} from "./models.js";
import { resolveVercelAiGatewayThinkingProfile } from "./thinking.js";

export function resolveVercelAiGatewayModel(modelId: string) {
  const model = resolveVercelAiGatewayDynamicModel(modelId);
  return {
    ...model,
    reasoning: model.reasoning || Boolean(resolveVercelAiGatewayThinkingProfile(modelId)),
    input: model.input.includes("image") ? (["text", "image"] as const) : (["text"] as const),
    api: "anthropic-messages" as const,
    provider: VERCEL_AI_GATEWAY_PROVIDER_ID,
    baseUrl: VERCEL_AI_GATEWAY_BASE_URL,
  };
}

export function buildStaticVercelAiGatewayProvider(): ModelProviderConfig {
  return {
    baseUrl: VERCEL_AI_GATEWAY_BASE_URL,
    api: "anthropic-messages",
    models: getStaticVercelAiGatewayModelCatalog(),
  };
}

export async function buildVercelAiGatewayProvider(): Promise<ModelProviderConfig> {
  return {
    baseUrl: VERCEL_AI_GATEWAY_BASE_URL,
    api: "anthropic-messages",
    models: await discoverVercelAiGatewayModels(),
  };
}
