import { nn as ProviderPlugin } from "../../types-DKA4S1yN.js";
//#region extensions/google/provider-contract-api.d.ts
declare function createGoogleProvider(): ProviderPlugin;
declare function createGoogleVertexProvider(): ProviderPlugin;
declare function createGoogleGeminiCliProvider(): ProviderPlugin;
//#endregion
export { createGoogleGeminiCliProvider, createGoogleProvider, createGoogleVertexProvider };