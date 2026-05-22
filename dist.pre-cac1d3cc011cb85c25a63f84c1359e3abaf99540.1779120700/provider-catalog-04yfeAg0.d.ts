import { l as ModelProviderConfig } from "./types.models-BCM1Na_a.js";
//#region extensions/kilocode/provider-catalog.d.ts
declare function buildKilocodeProvider(): ModelProviderConfig;
declare function buildKilocodeProviderWithDiscovery(): Promise<ModelProviderConfig>;
//#endregion
export { buildKilocodeProviderWithDiscovery as n, buildKilocodeProvider as t };