//#region extensions/xai/api.d.ts
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
export { shouldContributeXaiCompat as i, resolveXaiBaseUrl as n, resolveXaiTransport as r, isXaiModelHint as t };