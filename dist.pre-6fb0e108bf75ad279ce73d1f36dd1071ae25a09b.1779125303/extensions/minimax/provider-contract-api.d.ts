import { sn as ProviderPlugin } from "../../types-CPAF_tyr.js";
//#region extensions/minimax/provider-contract-api.d.ts
declare function createMinimaxProvider(): ProviderPlugin;
declare function createMinimaxPortalProvider(): ProviderPlugin;
//#endregion
export { createMinimaxPortalProvider, createMinimaxProvider };