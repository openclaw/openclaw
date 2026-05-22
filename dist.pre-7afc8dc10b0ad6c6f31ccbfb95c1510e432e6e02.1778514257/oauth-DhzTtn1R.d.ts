import { o as GeminiCliOAuthContext, s as GeminiCliOAuthCredentials } from "./oauth.shared-BoIK_D-K.js";

//#region extensions/google/oauth.d.ts
declare function loginGeminiCliOAuth(ctx: GeminiCliOAuthContext): Promise<GeminiCliOAuthCredentials>;
//#endregion
export { loginGeminiCliOAuth as t };