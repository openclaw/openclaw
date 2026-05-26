import { l as ModelProviderConfig } from "./types.models-CkWCv1xp.js";
//#region extensions/chutes/provider-catalog.d.ts
declare function buildStaticChutesProvider(): ModelProviderConfig;
/**
 * Build the Chutes provider with dynamic model discovery.
 * Falls back to the static catalog on failure.
 * Accepts an optional access token (API key or OAuth access token) for authenticated discovery.
 */
declare function buildChutesProvider(accessToken?: string): Promise<ModelProviderConfig>;
//#endregion
export { buildStaticChutesProvider as n, buildChutesProvider as t };