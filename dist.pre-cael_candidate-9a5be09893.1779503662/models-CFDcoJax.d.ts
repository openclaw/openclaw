import { s as ModelDefinitionConfig } from "./types.models-tqxsISRc.js";
//#region extensions/cloudflare-ai-gateway/models.d.ts
declare const CLOUDFLARE_AI_GATEWAY_PROVIDER_ID = "cloudflare-ai-gateway";
declare const CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_ID = "claude-sonnet-4-6";
declare const CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF = "cloudflare-ai-gateway/claude-sonnet-4-6";
declare function buildCloudflareAiGatewayModelDefinition(params?: {
  id?: string;
  name?: string;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
}): ModelDefinitionConfig;
declare function resolveCloudflareAiGatewayBaseUrl(params: {
  accountId: string;
  gatewayId: string;
}): string;
//#endregion
export { resolveCloudflareAiGatewayBaseUrl as a, buildCloudflareAiGatewayModelDefinition as i, CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF as n, CLOUDFLARE_AI_GATEWAY_PROVIDER_ID as r, CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_ID as t };