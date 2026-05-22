import { p as resolveXaiModelCompatPatch$1 } from "./provider-tools-Bti5WIen.js";
//#region extensions/xai/api.d.ts
declare const resolveXaiModelCompatPatch: typeof resolveXaiModelCompatPatch$1;
declare function isXaiModelHint(modelId: string): boolean;
declare function shouldContributeXaiCompat(params: {
  modelId: string;
  model: {
    api?: unknown;
    baseUrl?: unknown;
  };
}): boolean;
declare function resolveXaiTransport(params: {
  provider: string;
  api?: unknown;
  baseUrl?: unknown;
}): {
  api: "openai-responses";
  baseUrl?: string;
} | undefined;
declare function resolveXaiBaseUrl(baseUrlOrConfig?: unknown): string;
//#endregion
export { shouldContributeXaiCompat as a, resolveXaiTransport as i, resolveXaiBaseUrl as n, resolveXaiModelCompatPatch as r, isXaiModelHint as t };