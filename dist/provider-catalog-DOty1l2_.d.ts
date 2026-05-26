import { l as ModelProviderConfig } from "./types.models-CkWCv1xp.js";
//#region extensions/openrouter/provider-catalog.d.ts
declare const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
declare function normalizeOpenRouterBaseUrl(baseUrl: string | undefined): string | undefined;
declare function isOpenRouterProxyReasoningUnsupportedModel(modelId: string | undefined): boolean;
declare function buildOpenrouterProvider(): ModelProviderConfig;
//#endregion
export { normalizeOpenRouterBaseUrl as i, buildOpenrouterProvider as n, isOpenRouterProxyReasoningUnsupportedModel as r, OPENROUTER_BASE_URL as t };