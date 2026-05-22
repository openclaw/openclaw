import { f as ModelProviderDeclarationConfig } from "./types.models-tqxsISRc.js";
//#region extensions/openrouter/provider-catalog.d.ts
declare const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
declare function normalizeOpenRouterBaseUrl(baseUrl: string | undefined): string | undefined;
declare function isOpenRouterProxyReasoningUnsupportedModel(modelId: string | undefined): boolean;
declare function buildOpenrouterProvider(): ModelProviderDeclarationConfig;
//#endregion
export { normalizeOpenRouterBaseUrl as i, buildOpenrouterProvider as n, isOpenRouterProxyReasoningUnsupportedModel as r, OPENROUTER_BASE_URL as t };