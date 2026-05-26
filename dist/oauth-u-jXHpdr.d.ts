import { c as OAuthCredential } from "./types-BwDj5PsX.js";
import { o as GeminiCliOAuthContext, s as GeminiCliOAuthCredentials } from "./oauth.shared-D9HFPX7J.js";

//#region extensions/google/oauth.d.ts
declare function loginGeminiCliOAuth(ctx: GeminiCliOAuthContext): Promise<GeminiCliOAuthCredentials>;
declare function refreshGeminiCliOAuthToken(credentials: Pick<GeminiCliOAuthCredentials, "refresh" | "email" | "projectId">): Promise<OAuthCredential>;
//#endregion
export { refreshGeminiCliOAuthToken as n, loginGeminiCliOAuth as t };