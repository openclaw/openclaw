import { l as ModelProviderConfig } from "./types.models-D7TQ4_r1.js";
//#region extensions/qwen/provider-catalog.d.ts
declare function buildQwenProvider(params?: {
  baseUrl?: string;
}): ModelProviderConfig;
declare const buildModelStudioProvider: typeof buildQwenProvider;
//#endregion
export { buildQwenProvider as n, buildModelStudioProvider as t };