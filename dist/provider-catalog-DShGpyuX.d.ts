import { l as ModelProviderConfig } from "./types.models-CkWCv1xp.js";
//#region extensions/qwen/provider-catalog.d.ts
declare function buildQwenProvider(params?: {
  baseUrl?: string;
}): ModelProviderConfig;
declare const buildModelStudioProvider: typeof buildQwenProvider;
//#endregion
export { buildQwenProvider as n, buildModelStudioProvider as t };