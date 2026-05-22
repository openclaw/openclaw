import { nn as ProviderPlugin } from "../../types-D1CySu2x.js";
//#region extensions/google/provider-contract-api.d.ts
declare function createGoogleProvider(): ProviderPlugin;
declare function createGoogleVertexProvider(): ProviderPlugin;
declare function createGoogleGeminiCliProvider(): ProviderPlugin;
//#endregion
export { createGoogleGeminiCliProvider, createGoogleProvider, createGoogleVertexProvider };