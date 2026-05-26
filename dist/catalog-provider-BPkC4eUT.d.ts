import { s as ModelDefinitionConfig } from "./types.models-tqxsISRc.js";
//#region extensions/cloudflare-ai-gateway/catalog-provider.d.ts
type CloudflareAiGatewayCredential = {
  type?: string;
  keyRef?: unknown;
  key?: unknown;
  metadata?: {
    accountId?: unknown;
    gatewayId?: unknown;
  };
} | undefined;
declare function buildCloudflareAiGatewayCatalogProvider(params: {
  credential: CloudflareAiGatewayCredential;
  envApiKey?: string;
}): {
  baseUrl: string;
  api: "anthropic-messages";
  apiKey: string;
  models: ModelDefinitionConfig[];
} | null;
//#endregion
export { buildCloudflareAiGatewayCatalogProvider as t };