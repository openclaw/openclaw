import { f as ModelProviderDeclarationConfig } from "./types.models-tqxsISRc.js";
//#region extensions/kimi-coding/provider-catalog.d.ts
declare function buildKimiCodingProvider(): ModelProviderDeclarationConfig;
declare function normalizeKimiCodingModelId(modelId: string): string;
declare const KIMI_CODING_BASE_URL = "https://api.kimi.com/coding/";
declare const KIMI_CODING_DEFAULT_MODEL_ID = "kimi-for-coding";
declare const KIMI_CODING_LEGACY_MODEL_IDS: readonly ["kimi-code", "k2p5"];
//#endregion
export { normalizeKimiCodingModelId as a, buildKimiCodingProvider as i, KIMI_CODING_DEFAULT_MODEL_ID as n, KIMI_CODING_LEGACY_MODEL_IDS as r, KIMI_CODING_BASE_URL as t };