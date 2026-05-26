import { s as ModelDefinitionConfig } from "./types.models-tqxsISRc.js";
//#region extensions/tencent/models.d.ts
declare const TOKENHUB_PROVIDER_ID = "tencent-tokenhub";
declare const TOKENHUB_BASE_URL: string;
declare const TOKENHUB_MODEL_CATALOG: ModelDefinitionConfig[];
declare function buildTokenHubModelDefinition(model: (typeof TOKENHUB_MODEL_CATALOG)[number]): ModelDefinitionConfig;
//#endregion
export { buildTokenHubModelDefinition as i, TOKENHUB_MODEL_CATALOG as n, TOKENHUB_PROVIDER_ID as r, TOKENHUB_BASE_URL as t };