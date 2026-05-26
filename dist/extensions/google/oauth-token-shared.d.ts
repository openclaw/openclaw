//#region extensions/google/oauth-token-shared.d.ts
type GoogleOauthApiKeyCredential = {
  type?: string;
  access?: string;
  projectId?: string;
};
declare function parseGoogleOauthApiKey(apiKey: string): {
  token?: string;
  projectId?: string;
} | null;
declare function formatGoogleOauthApiKey(cred: GoogleOauthApiKeyCredential): string;
declare function parseGoogleUsageToken(apiKey: string): string;
//#endregion
export { formatGoogleOauthApiKey, parseGoogleOauthApiKey, parseGoogleUsageToken };