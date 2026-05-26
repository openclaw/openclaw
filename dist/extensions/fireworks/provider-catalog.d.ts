import { f as ModelProviderDeclarationConfig, s as ModelDefinitionConfig } from "../../types.models-tqxsISRc.js";
//#region extensions/fireworks/provider-catalog.d.ts
declare const FIREWORKS_BASE_URL: string;
declare const FIREWORKS_DEFAULT_MODEL_ID = "accounts/fireworks/routers/kimi-k2p5-turbo";
declare const FIREWORKS_K2_6_MODEL_ID = "accounts/fireworks/models/kimi-k2p6";
declare const FIREWORKS_DEFAULT_CONTEXT_WINDOW: number;
declare const FIREWORKS_DEFAULT_MAX_TOKENS: number;
declare const FIREWORKS_K2_6_CONTEXT_WINDOW: number;
declare const FIREWORKS_K2_6_MAX_TOKENS: number;
declare function buildFireworksCatalogModels(): ModelDefinitionConfig[];
declare function buildFireworksProvider(): ModelProviderDeclarationConfig;
//#endregion
export { FIREWORKS_BASE_URL, FIREWORKS_DEFAULT_CONTEXT_WINDOW, FIREWORKS_DEFAULT_MAX_TOKENS, FIREWORKS_DEFAULT_MODEL_ID, FIREWORKS_K2_6_CONTEXT_WINDOW, FIREWORKS_K2_6_MAX_TOKENS, FIREWORKS_K2_6_MODEL_ID, buildFireworksCatalogModels, buildFireworksProvider };