import { l as ModelProviderConfig } from "./types.models-DPSsoV9Y.js";
//#region extensions/huggingface/provider-catalog.d.ts
declare function buildHuggingfaceProvider(discoveryApiKey?: string): Promise<ModelProviderConfig>;
//#endregion
export { buildHuggingfaceProvider as t };