import { f as ModelProviderDeclarationConfig } from "./types.models-tqxsISRc.js";
//#region extensions/moonshot/provider-catalog.d.ts
declare const MOONSHOT_BASE_URL = "https://api.moonshot.ai/v1";
declare const MOONSHOT_CN_BASE_URL = "https://api.moonshot.cn/v1";
declare const MOONSHOT_DEFAULT_MODEL_ID = "kimi-k2.6";
declare function isNativeMoonshotBaseUrl(baseUrl: string | undefined): boolean;
declare function applyMoonshotNativeStreamingUsageCompat(provider: ModelProviderDeclarationConfig): ModelProviderDeclarationConfig;
declare function buildMoonshotProvider(): ModelProviderDeclarationConfig;
//#endregion
export { buildMoonshotProvider as a, applyMoonshotNativeStreamingUsageCompat as i, MOONSHOT_CN_BASE_URL as n, isNativeMoonshotBaseUrl as o, MOONSHOT_DEFAULT_MODEL_ID as r, MOONSHOT_BASE_URL as t };