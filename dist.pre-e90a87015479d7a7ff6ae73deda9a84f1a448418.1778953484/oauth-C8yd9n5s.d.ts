import { o as GeminiCliOAuthContext, s as GeminiCliOAuthCredentials } from "./oauth.shared-GsiUgltu.js";

//#region extensions/google/oauth.d.ts
declare function loginGeminiCliOAuth(ctx: GeminiCliOAuthContext): Promise<GeminiCliOAuthCredentials>;
//#endregion
export { loginGeminiCliOAuth as t };