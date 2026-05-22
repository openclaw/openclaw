import { i as OpenClawConfig } from "./types.openclaw-BlE9q7jU.js";
//#region extensions/sglang/models.d.ts
type ModelsConfig = NonNullable<OpenClawConfig["models"]>;
type ProviderConfig = NonNullable<ModelsConfig["providers"]>[string];
declare function buildSglangProvider(params?: {
  baseUrl?: string;
  apiKey?: string;
}): Promise<ProviderConfig>;
//#endregion
export { buildSglangProvider as t };