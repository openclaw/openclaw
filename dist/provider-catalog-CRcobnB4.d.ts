import { f as ModelProviderDeclarationConfig } from "./types.models-tqxsISRc.js";
//#region extensions/chutes/provider-catalog.d.ts
declare function buildStaticChutesProvider(): ModelProviderDeclarationConfig;
/**
 * Build the Chutes provider with dynamic model discovery.
 * Falls back to the static catalog on failure.
 * Accepts an optional access token (API key or OAuth access token) for authenticated discovery.
 */
declare function buildChutesProvider(accessToken?: string): Promise<ModelProviderDeclarationConfig>;
//#endregion
export { buildStaticChutesProvider as n, buildChutesProvider as t };