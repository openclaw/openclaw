import { l as ModelProviderConfig } from "./types.models-CkWCv1xp.js";
//#region extensions/arcee/provider-catalog.d.ts
declare const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
declare function normalizeArceeOpenRouterBaseUrl(baseUrl: string | undefined): string | undefined;
declare function toArceeOpenRouterModelId(modelId: string): string;
declare function buildArceeCatalogModels(): NonNullable<ModelProviderConfig["models"]>;
declare function buildArceeOpenRouterCatalogModels(): NonNullable<ModelProviderConfig["models"]>;
declare function buildArceeProvider(): ModelProviderConfig;
declare function buildArceeOpenRouterProvider(): ModelProviderConfig;
//#endregion
export { buildArceeProvider as a, buildArceeOpenRouterProvider as i, buildArceeCatalogModels as n, normalizeArceeOpenRouterBaseUrl as o, buildArceeOpenRouterCatalogModels as r, toArceeOpenRouterModelId as s, OPENROUTER_BASE_URL as t };