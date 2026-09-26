/** These markers describe the grant actually returned by OpenAI, not requested scopes. */
export const TOKEN_SHARING_AUTH_FLOW = "chatgpt-token-sharing";
export const IDENTITY_AUTH_FLOW = "chatgpt-identity";
export const TOKEN_SHARING_RESOURCE = "https://api.openai.com/v1";
export const TOKEN_SHARING_ISSUER = "https://auth.openai.com";
export const TOKEN_SHARING_REDIRECT_URI = "http://localhost:8080/auth/callback";
export const TOKEN_SHARING_SCOPE =
  "openid email profile resource.invoke chatgpt.tokens.use.direct offline_access";
// Existing static registrations did not request email/profile permissions.
export const TOKEN_SHARING_LEGACY_SCOPE =
  "openid resource.invoke chatgpt.tokens.use.direct offline_access";

// AuthAPI registers a user/workspace-bound client during this authorization flow.
// The callback's real client ID replaces this marker for exchange and refresh.
export const TOKEN_SHARING_CLIENT_ID = "dynamic_agent_client";

export function isSIWCAuthFlow(authFlow: string | undefined): boolean {
  return authFlow === TOKEN_SHARING_AUTH_FLOW || authFlow === IDENTITY_AUTH_FLOW;
}
