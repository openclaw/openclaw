import { u as ModelProviderConfig } from "./types.models-tqxsISRc.js";
import { Yn as ProviderDefaultThinkingPolicyContext, Zn as ProviderThinkingProfile } from "./types-Vx7Jq4_-2.js";
//#region extensions/google/provider-policy.d.ts
type GoogleApiCarrier = {
  api?: string | null;
};
type GoogleProviderConfigLike = GoogleApiCarrier & {
  models?: ReadonlyArray<GoogleApiCarrier | null | undefined> | null;
};
declare const DEFAULT_GOOGLE_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
declare function normalizeGoogleApiBaseUrl(baseUrl?: string): string;
declare function isGoogleGenerativeAiApi(api?: string | null): boolean;
declare function normalizeGoogleGenerativeAiBaseUrl(baseUrl?: string): string | undefined;
declare function resolveGoogleGenerativeAiTransport<TApi extends string | null | undefined>(params: {
  api: TApi;
  baseUrl?: string;
}): {
  api: TApi;
  baseUrl?: string;
};
declare function resolveGoogleGenerativeAiApiOrigin(baseUrl?: string): string;
declare function shouldNormalizeGoogleGenerativeAiProviderConfig(providerKey: string, provider: GoogleProviderConfigLike): boolean;
declare function shouldNormalizeGoogleProviderConfig(providerKey: string, provider: GoogleProviderConfigLike): boolean;
declare function normalizeGoogleProviderConfig(providerKey: string, provider: ModelProviderConfig): ModelProviderConfig;
declare function resolveGoogleThinkingProfile({
  modelId,
  reasoning
}: ProviderDefaultThinkingPolicyContext): ProviderThinkingProfile | undefined;
//#endregion
export { normalizeGoogleProviderConfig as a, resolveGoogleThinkingProfile as c, normalizeGoogleGenerativeAiBaseUrl as i, shouldNormalizeGoogleGenerativeAiProviderConfig as l, isGoogleGenerativeAiApi as n, resolveGoogleGenerativeAiApiOrigin as o, normalizeGoogleApiBaseUrl as r, resolveGoogleGenerativeAiTransport as s, DEFAULT_GOOGLE_API_BASE_URL as t, shouldNormalizeGoogleProviderConfig as u };