import { o as GeminiCliOAuthContext, s as GeminiCliOAuthCredentials } from "./oauth.shared-D-DPN-ZM.js";

//#region extensions/google/oauth.d.ts
declare function loginGeminiCliOAuth(ctx: GeminiCliOAuthContext): Promise<GeminiCliOAuthCredentials>;
//#endregion
export { loginGeminiCliOAuth as t };