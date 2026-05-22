import { nn as ProviderPlugin, v as OpenClawPluginApi } from "./types-CT4HF0Ri.js";
//#region extensions/google/gemini-cli-provider.d.ts
declare function buildGoogleGeminiCliProvider(): ProviderPlugin;
declare function registerGoogleGeminiCliProvider(api: OpenClawPluginApi): void;
//#endregion
export { registerGoogleGeminiCliProvider as n, buildGoogleGeminiCliProvider as t };