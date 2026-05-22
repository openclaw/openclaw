import { s as GeminiCliOAuthCredentials } from "../../oauth.shared-CLuoodFD.js";

//#region extensions/google/oauth.token.d.ts
declare function exchangeCodeForTokens(code: string, verifier: string): Promise<GeminiCliOAuthCredentials>;
declare function refreshTokensForGeminiCli(credentials: {
  refresh: string;
  email?: string;
  projectId?: string;
}): Promise<GeminiCliOAuthCredentials>;
//#endregion
export { exchangeCodeForTokens, refreshTokensForGeminiCli };