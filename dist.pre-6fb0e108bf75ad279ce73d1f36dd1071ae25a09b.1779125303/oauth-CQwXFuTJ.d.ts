import { c as OAuthCredential } from "./types-jIZ8LCiF.js";
import { o as GeminiCliOAuthContext, s as GeminiCliOAuthCredentials } from "./oauth.shared-C5RN4TpJ.js";

//#region extensions/google/oauth.d.ts
declare function loginGeminiCliOAuth(ctx: GeminiCliOAuthContext): Promise<GeminiCliOAuthCredentials>;
declare function refreshGeminiCliOAuthToken(credentials: Pick<GeminiCliOAuthCredentials, "refresh" | "email" | "projectId">): Promise<OAuthCredential>;
//#endregion
export { refreshGeminiCliOAuthToken as n, loginGeminiCliOAuth as t };