import { sn as ProviderPlugin } from "../../types-UTp4ves_.js";
//#region extensions/minimax/provider-contract-api.d.ts
declare function createMinimaxProvider(): ProviderPlugin;
declare function createMinimaxPortalProvider(): ProviderPlugin;
//#endregion
export { createMinimaxPortalProvider, createMinimaxProvider };