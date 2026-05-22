import { sn as ProviderPlugin } from "../../types-CPAF_tyr.js";
//#region extensions/openai/provider-contract-api.d.ts
declare function createOpenAICodexProvider(): ProviderPlugin;
declare function createOpenAIProvider(): ProviderPlugin;
//#endregion
export { createOpenAICodexProvider, createOpenAIProvider };