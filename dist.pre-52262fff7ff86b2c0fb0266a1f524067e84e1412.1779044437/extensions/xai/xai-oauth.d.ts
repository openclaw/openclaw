import { c as OAuthCredential } from "../../types-Ce68c77g.js";
import { Ct as ProviderAuthMethod, Et as ProviderAuthResult, bt as ProviderAuthContext } from "../../types-DzWIJtb62.js";
//#region extensions/xai/xai-oauth.d.ts
declare const XAI_OAUTH_METHOD_ID = "oauth";
declare const XAI_OAUTH_CHOICE_ID = "xai-oauth";
declare const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
declare const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access";
declare const XAI_OAUTH_ISSUER = "https://auth.x.ai";
declare const XAI_OAUTH_DISCOVERY_URL = "https://auth.x.ai/.well-known/openid-configuration";
declare const XAI_OAUTH_CALLBACK_HOST = "127.0.0.1";
declare const XAI_OAUTH_CALLBACK_PORT = 56121;
declare const XAI_OAUTH_CALLBACK_PATH = "/callback";
declare const XAI_OAUTH_REDIRECT_URI = "http://127.0.0.1:56121/callback";
type XaiOAuthDiscovery = {
  authorizationEndpoint: string;
  tokenEndpoint: string;
};
type XaiOAuthFetchOptions = {
  fetchImpl?: typeof fetch;
  now?: () => number;
};
declare function isTrustedXaiOAuthEndpoint(endpoint: string): boolean;
declare function fetchXaiOAuthDiscovery(options?: XaiOAuthFetchOptions): Promise<XaiOAuthDiscovery>;
declare function buildXaiOAuthAuthorizeUrl(params: {
  authorizationEndpoint: string;
  state: string;
  nonce: string;
  challenge: string;
}): string;
declare function loginXaiOAuth(ctx: ProviderAuthContext): Promise<ProviderAuthResult>;
declare function refreshXaiOAuthCredential(credential: OAuthCredential, options?: XaiOAuthFetchOptions): Promise<OAuthCredential>;
declare function createXaiOAuthAuthMethod(): ProviderAuthMethod;
//#endregion
export { XAI_OAUTH_CALLBACK_HOST, XAI_OAUTH_CALLBACK_PATH, XAI_OAUTH_CALLBACK_PORT, XAI_OAUTH_CHOICE_ID, XAI_OAUTH_CLIENT_ID, XAI_OAUTH_DISCOVERY_URL, XAI_OAUTH_ISSUER, XAI_OAUTH_METHOD_ID, XAI_OAUTH_REDIRECT_URI, XAI_OAUTH_SCOPE, buildXaiOAuthAuthorizeUrl, createXaiOAuthAuthMethod, fetchXaiOAuthDiscovery, isTrustedXaiOAuthEndpoint, loginXaiOAuth, refreshXaiOAuthCredential };