import { n as PinnedDispatcherPolicy } from "./ssrf-skjEI_i5.js";
import { a as ProviderRequestTransportOverrides, o as ResolvedProviderRequestConfig } from "./provider-request-config-Ckb2OLir.js";
//#region extensions/google/api.d.ts
type GoogleGenerativeAiRequestOverrides = ProviderRequestTransportOverrides & {
  allowPrivateNetwork?: boolean;
};
declare function resolveGoogleGenerativeAiHttpRequestConfig(params: {
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  request?: GoogleGenerativeAiRequestOverrides;
  capability: "image" | "audio" | "video";
  transport: "http" | "media-understanding";
}): {
  baseUrl: string;
  allowPrivateNetwork: boolean;
  headers: Headers;
  dispatcherPolicy?: PinnedDispatcherPolicy;
  requestConfig: ResolvedProviderRequestConfig;
};
//#endregion
export { resolveGoogleGenerativeAiHttpRequestConfig as t };