import { l as ModelProviderConfig } from "./types.models-DPSsoV9Y.js";
//#region extensions/vercel-ai-gateway/provider-catalog.d.ts
declare function buildStaticVercelAiGatewayProvider(): ModelProviderConfig;
declare function buildVercelAiGatewayProvider(): Promise<ModelProviderConfig>;
//#endregion
export { buildVercelAiGatewayProvider as n, buildStaticVercelAiGatewayProvider as t };