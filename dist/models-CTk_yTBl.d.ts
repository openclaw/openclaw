import { s as ModelDefinitionConfig } from "./types.models-tqxsISRc.js";
//#region extensions/venice/models.d.ts
declare const VENICE_BASE_URL: string;
declare const VENICE_DEFAULT_MODEL_REF = "venice/kimi-k2-5";
declare const VENICE_MODEL_CATALOG: ModelDefinitionConfig[];
type VeniceCatalogEntry = ModelDefinitionConfig;
declare function buildVeniceModelDefinition(entry: VeniceCatalogEntry): ModelDefinitionConfig;
type VeniceModelDiscoveryOptions = {
  retryDelayMs?: number;
};
declare function discoverVeniceModels(options?: VeniceModelDiscoveryOptions): Promise<ModelDefinitionConfig[]>;
//#endregion
export { discoverVeniceModels as a, buildVeniceModelDefinition as i, VENICE_DEFAULT_MODEL_REF as n, VENICE_MODEL_CATALOG as r, VENICE_BASE_URL as t };