import { f as ModelProviderDeclarationConfig } from "./types.models-tqxsISRc.js";
//#region extensions/qianfan/provider-catalog.d.ts
declare const QIANFAN_BASE_URL = "https://qianfan.baidubce.com/v2";
declare const QIANFAN_DEFAULT_MODEL_ID = "deepseek-v3.2";
declare function buildQianfanProvider(): ModelProviderDeclarationConfig;
//#endregion
export { QIANFAN_DEFAULT_MODEL_ID as n, buildQianfanProvider as r, QIANFAN_BASE_URL as t };