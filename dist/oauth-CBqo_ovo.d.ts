import { o as GeminiCliOAuthContext, s as GeminiCliOAuthCredentials } from "./oauth.shared-B4Jdigcn.js";

//#region extensions/google/oauth.d.ts
declare function loginGeminiCliOAuth(ctx: GeminiCliOAuthContext): Promise<GeminiCliOAuthCredentials>;
//#endregion
export { loginGeminiCliOAuth as t };