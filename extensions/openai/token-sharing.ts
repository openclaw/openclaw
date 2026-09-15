/** These markers describe the grant actually returned by OpenAI, not requested scopes. */
export const TOKEN_SHARING_AUTH_FLOW = "chatgpt-token-sharing";
export const IDENTITY_AUTH_FLOW = "chatgpt-identity";
export const TOKEN_SHARING_RESOURCE = "https://api.openai.com/v1";
export const TOKEN_SHARING_ISSUER = "https://auth.openai.com";
export const TOKEN_SHARING_REDIRECT_URI = "http://localhost:8080/auth/callback";
export const TOKEN_SHARING_SCOPE =
  "openid resource.invoke chatgpt.tokens.use.direct offline_access";

// Release prerequisite: replace with the public client approved for OpenClaw.
// A shared dogfood client is not an approved distribution identity.
export const TOKEN_SHARING_CLIENT_ID: string | undefined = undefined;

export function isTokenSharingAuthFlow(authFlow: string | undefined): boolean {
  return authFlow === TOKEN_SHARING_AUTH_FLOW || authFlow === IDENTITY_AUTH_FLOW;
}
