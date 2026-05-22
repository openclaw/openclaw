import { f as ModelProviderDeclarationConfig } from "./types.models-tqxsISRc.js";
//#region extensions/nvidia/provider-catalog.d.ts
declare const NVIDIA_DEFAULT_MODEL_ID = "nvidia/nemotron-3-super-120b-a12b";
declare function buildNvidiaProvider(): ModelProviderDeclarationConfig;
//#endregion
export { buildNvidiaProvider as n, NVIDIA_DEFAULT_MODEL_ID as t };