import { c as OAuthCredential } from "./types-Re9KW3tr2.js";
import { o as GeminiCliOAuthContext, s as GeminiCliOAuthCredentials } from "./oauth.shared-DoC5XITG.js";

//#region extensions/google/oauth.d.ts
declare function loginGeminiCliOAuth(ctx: GeminiCliOAuthContext): Promise<GeminiCliOAuthCredentials>;
declare function refreshGeminiCliOAuthToken(credentials: Pick<GeminiCliOAuthCredentials, "refresh" | "email" | "projectId">): Promise<OAuthCredential>;
//#endregion
export { refreshGeminiCliOAuthToken as n, loginGeminiCliOAuth as t };